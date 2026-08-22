import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GENERATION_LIMITS } from "./limits";

/**
 * Structural guarantees about the guided flow, checked by reading the source.
 *
 * The same idea as `safety-envelope.test.ts`: some properties are not about
 * what a function returns but about what the code is ALLOWED to reach. Those
 * cannot be asserted by calling anything, so they are asserted by reading.
 */

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.resolve(ROOT, relative), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const SRC = path.resolve(ROOT, "src");
const ALL_SOURCES = walk(SRC).filter(
  (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
);

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

describe("the ETA is presentation only", () => {
  /**
   * THE PROPERTY THAT MATTERS.
   *
   * An ETA that could influence a request, a reservation, a retry, a tile
   * choice or a stop condition would stop being a display and start being a
   * scheduler. Nothing downstream of a spending decision may import it.
   */
  it("is never imported by anything that requests, reserves, retries or selects", () => {
    const forbidden = ALL_SOURCES.filter((file) => {
      const rel = relative(file);
      const isSpendingPath =
        rel.startsWith("src/server/places/") ||
        rel.startsWith("src/server/search/") ||
        rel.startsWith("src/server/quota/") ||
        rel.startsWith("src/server/pricing/") ||
        rel.startsWith("src/server/enrichment/") ||
        rel.startsWith("src/server/worker/");

      if (!isSpendingPath) return false;
      return /generate\/(eta|calibration)/.test(read(file));
    });

    expect(forbidden.map(relative)).toEqual([]);
  });

  it("reads no clock of its own", () => {
    const eta = read("src/lib/generate/eta.ts");
    // Every input is passed in, which is what makes the rules testable with
    // fixed arrays rather than by waiting.
    expect(eta).not.toMatch(/Date\.now\(\)/);
    expect(eta).not.toMatch(/new Date\(\)/);
  });

  it("never presents a remaining figure of zero while work is owed", () => {
    const eta = read("src/lib/generate/eta.ts");
    // `formatDurationApprox` floors at one second precisely so that a live run
    // can never render "0 sec remaining".
    expect(eta).toMatch(/Math\.max\(seconds, 1\)/);
  });
});

describe("the generation run row stores no countable figures", () => {
  const migration = read("supabase/migrations/0014_generation_runs.sql");

  it.each([
    "leads_found",
    "leads_count",
    "coverage_pct",
    "tiles_covered",
    "tiles_pending",
    "emails_found",
    "api_calls_run",
    "calls_used",
  ])("has no %s column", (column) => {
    // Every one of these already has an owner. A second copy is a second
    // chance to be wrong, and the copy is what a stale UI reads.
    expect(migration).not.toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
  });

  it("keeps only a watermark, from which usage is derived", () => {
    expect(migration).toMatch(/api_calls_at_start\s+integer/);
    expect(read("src/server/generate/limits.ts")).toMatch(
      /searchApiCallsRun - args\.apiCallsAtStart/,
    );
  });

  it("records consent as a timestamp rather than a flag", () => {
    expect(migration).toMatch(/enrichment_consented_at\s+timestamptz/);
    expect(migration).not.toMatch(/enrichment_consented\s+boolean/);
  });

  it("grants the browser read access and nothing else", () => {
    expect(migration).toMatch(/for select to authenticated/);
    // A row the browser could write is a ceiling the browser could raise.
    expect(migration).not.toMatch(/for (insert|update|delete) to authenticated/);
  });
});

describe("the approval ceiling", () => {
  it("is read from the server constant, never from a request body", () => {
    const orchestrator = read("src/server/generate/orchestrator.ts");
    expect(orchestrator).toMatch(/call_ceiling: GENERATION_LIMITS\.maxGoogleCallsPerRun/);

    // No path may take a ceiling from input.
    expect(orchestrator).not.toMatch(/call_ceiling:\s*(input|args|payload|body|parsed)\./);
  });

  it("is not accepted as a parameter by the advance route", () => {
    const route = read("src/app/api/generate/[id]/advance/route.ts");
    // The route deliberately does not read the body at all.
    expect(route).not.toMatch(/request\.json\(\)/);
  });

  it("matches the default written into the schema", () => {
    const migration = read("supabase/migrations/0014_generation_runs.sql");
    expect(migration).toMatch(
      new RegExp(
        `call_ceiling\\s+integer not null default ${GENERATION_LIMITS.maxGoogleCallsPerRun}`,
      ),
    );
  });
});

describe("the orchestrator coordinates rather than implements", () => {
  const orchestrator = read("src/server/generate/orchestrator.ts");

  it("does not record API calls or touch the usage counters itself", () => {
    // Billing is `record_api_call`'s job, reached only from the tick runner.
    expect(orchestrator).not.toMatch(/record_api_call/);
    expect(orchestrator).not.toMatch(/api_usage_counters/);
  });

  it("never writes the worker switch", () => {
    for (const file of ALL_SOURCES) {
      const source = read(relative(file));
      expect(source).not.toMatch(/worker_config[\s\S]{0,80}(update|insert|upsert)/i);
    }
  });

  it("reserves nothing of its own", () => {
    // The reservation happens at the lowest level that can spend a call. A
    // second reservation here would double-count against the free allowance.
    expect(orchestrator).not.toMatch(/reserve_api_calls|reserveCalls/);
  });

  it("passes only a NARROWER area cap to the tick runner", () => {
    expect(orchestrator).toMatch(/maxTilesPerTick: areas/);
    // It must not hand the runner a longer slice or a bigger page budget.
    expect(orchestrator).not.toMatch(/maxTickMs:/);
    expect(orchestrator).not.toMatch(/maxPages:/);
    expect(orchestrator).not.toMatch(/maxAttempts:/);
  });

  it("requires an explicit fetch for a live email run", () => {
    // `runEnrichment` throws rather than guessing one, so a missing fetch
    // cannot silently become a network-capable default.
    expect(orchestrator).toMatch(/dryRun: false/);
    expect(orchestrator).toMatch(/fetchImpl: deps\.enrichmentFetch/);
  });
});

describe("the lead target never becomes a stop condition", () => {
  it("does not reintroduce the forbidden identifier anywhere in the guided flow", () => {
    const files = [
      ...walk(path.resolve(SRC, "server/generate")),
      ...walk(path.resolve(SRC, "lib/generate")),
      ...walk(path.resolve(SRC, "components/generate")),
    ].filter((file) => !file.endsWith(".test.ts"));

    for (const file of files) {
      expect(read(relative(file))).not.toMatch(/\btarget_reached\b/);
    }
  });

  it("makes no completion decision from the target", () => {
    const state = read("src/server/generate/state.ts");
    const orchestrator = read("src/server/generate/orchestrator.ts");

    // `targetReached` may be REPORTED. It may never be branched on to decide
    // whether the run continues.
    expect(state).not.toMatch(/if\s*\([^)]*targetReached/);
    expect(orchestrator).not.toMatch(/targetReached/);
    expect(orchestrator).not.toMatch(/leadsFound\s*>=\s*targetLeads/);
  });
});
