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

/**
 * Source with comments removed.
 *
 * Needed because several of these assertions ban a STRING FROM THE UI, and the
 * files that fixed those strings quite reasonably quote the old wording in a
 * comment explaining what was fixed. Scanning raw text would make writing that
 * explanation a test failure.
 */
function code(relativePath: string): string {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
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
    // 0014 created the column at the old 30-call gate; 0015 moved it to the hard
    // per-search limit when one press became one whole lifecycle. The LATER
    // migration is the one that has to agree with the constant.
    const migration = read("supabase/migrations/0015_generation_lifecycle.sql");
    expect(migration).toMatch(
      new RegExp(`set default ${GENERATION_LIMITS.maxGoogleCallsPerRun}\\b`),
    );
  });

  it("records in the schema that no safety limit was weakened", () => {
    // A reader six months from now will want to know exactly this, and the
    // migration is where they will look first.
    const migration = read("supabase/migrations/0015_generation_lifecycle.sql");
    expect(migration).toMatch(/NO SAFETY LIMIT IS WEAKENED/i);
    expect(migration).toMatch(/maxCallsPerSearch/);
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

describe("the one-click lifecycle", () => {
  const RESULTS_PAGE = "src/app/(app)/generate/[id]/results/page.tsx";
  const PROCESSING_VIEW = "src/components/generate/processing-view.tsx";

  /**
   * THE WORDING BUG THIS PASS EXISTS TO FIX.
   *
   * "Your leads so far are ready" appeared above a run that had searched a
   * fraction of its area and stopped at a call ceiling. It is gone, and stays
   * gone.
   */
  it("never renders 'so far' anywhere in the guided flow", () => {
    const files = [
      ...walk(path.resolve(SRC, "components/generate")),
      ...walk(path.resolve(SRC, "app/(app)/generate")),
      ...walk(path.resolve(SRC, "server/generate")),
    ].filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"));

    for (const file of files) {
      expect(code(relative(file))).not.toMatch(/so far are ready/i);
    }
  });

  it("takes the results heading from the server rather than composing one", () => {
    const page = code(RESULTS_PAGE);

    // A success heading is only ever reachable through `lifecycleComplete`,
    // which the server computes from coverage and email progress. Every other
    // state falls back to the server's own title, so no incomplete run can be
    // headed as though it finished.
    expect(page).toMatch(/title=\{state\.lifecycleComplete \? "Your Leads" : state\.title\}/);

    // And the page never decides on its own that a run succeeded.
    expect(page).not.toMatch(/"Your leads are ready"/);
    expect(page).not.toMatch(/fullyCovered \?[^:]*"Your/);
  });

  it("keeps the manual Continue action out of the primary flow", () => {
    const page = code(RESULTS_PAGE);
    const advancedAt = page.indexOf("Advanced controls");

    // Rendered USES of the component, not the import line.
    const rendered = "<ContinueGenerationButton";
    const continueAt = page.indexOf(rendered);

    // It still exists as a recovery action, but only below the Advanced
    // disclosure -- never among the primary buttons.
    expect(advancedAt).toBeGreaterThan(-1);
    expect(continueAt).toBeGreaterThan(advancedAt);

    const primarySection = page.slice(0, advancedAt);
    expect(primarySection).not.toMatch(/<ContinueGenerationButton/);
    expect(primarySection).toMatch(/<ExportExcelButton/);
  });

  it("advances automatically instead of waiting for a press", () => {
    const view = code(PROCESSING_VIEW);
    // The loop is driven by state, not by an onClick.
    expect(view).toMatch(/state\.canAdvance/);
    expect(view).not.toMatch(/onClick=\{[^}]*advance/i);
  });

  it("is honest that work pauses when the tab closes", () => {
    const view = read(PROCESSING_VIEW);
    // Read WITH comments here: the promise is made in the rendered copy, and the
    // module comment stating it is part of what must not regress.
    // The durable worker is off, so the UI must not imply background execution.
    expect(view).toMatch(/pauses where it is/i);
    expect(view).not.toMatch(/keeps? running (on the server|in the background)/i);
  });

  it("keeps a Stop control on the running screen", () => {
    expect(read(PROCESSING_VIEW)).toMatch(/Stop generation/);
  });

  it("holds no business logic in the client", () => {
    const view = code(PROCESSING_VIEW);
    // No budget arithmetic, no tile counting, no batch sizing in the browser.
    expect(view).not.toMatch(/maxTilesPerTick|areasAllowed|callsUsed|enrichmentLeadsPerAdvance/);
    expect(view).not.toMatch(/SEARCH_LIMITS|GENERATION_LIMITS/);
  });
});

describe("lease contention is transient, not terminal", () => {
  /**
   * THE REGRESSION GUARD FOR generation 2d3aacec.
   *
   * The tick runner used to throw a bare `Error` when the claim returned no
   * row, so the handler written to treat contention as transient could not
   * recognise the case it existed for. A run that went on to collect 357 leads
   * was recorded as unrecoverable. The TYPE is the fix, so the type is pinned.
   */
  it("throws a typed ClaimError when the lease is not granted", () => {
    const runner = read("src/server/search/run-controlled-tick.ts");

    const claimBlock = runner.slice(
      runner.indexOf("if (!claimedRow)"),
      runner.indexOf("const startedAt = now()"),
    );

    expect(claimBlock).toMatch(/throw new ClaimError\(/);
    // Specifically NOT a bare Error, which is what broke it.
    expect(claimBlock).not.toMatch(/throw new Error\(/);
    expect(runner).toMatch(/import \{ ClaimError, claimSearchById \}/);
  });

  it("routes a claim failure away from the generic failure path", () => {
    const orchestrator = read("src/server/generate/orchestrator.ts");

    // Contention gets its own handler, which distinguishes "someone is working"
    // from "this search cannot be driven".
    expect(orchestrator).toMatch(
      /if \(error instanceof ClaimError\) \{\s*return handleClaimFailure/,
    );
    expect(orchestrator).toMatch(/async function handleClaimFailure/);
    expect(orchestrator).toMatch(/search_unavailable/);
  });

  it("does not count contention against the liveness budget", () => {
    const orchestrator = read("src/server/generate/orchestrator.ts");
    const handler = orchestrator.slice(
      orchestrator.indexOf("async function handleClaimFailure"),
      orchestrator.indexOf("async function handleAdvanceError"),
    );

    // A 50-second slice would otherwise let a remounted client halt a healthy
    // run in seconds.
    expect(handler).not.toMatch(/trackProgress/);
  });
});

describe("the client cannot overlap advances", () => {
  it("guards in-flight advances at module scope, not in a ref", () => {
    const client = read("src/lib/generate/advance-client.ts");
    const view = read("src/components/generate/processing-view.tsx");

    // The registry outlives any component, which is what a remount defeats.
    expect(client).toMatch(/const inFlight = new Map</);
    // And the screen no longer keeps its own guard to reset on cleanup.
    expect(view).toMatch(/requestAdvance\(runId\)/);
    expect(view).not.toMatch(/inFlight\.current/);
  });

  it("shares the request rather than waiting out a delay", () => {
    const client = read("src/lib/generate/advance-client.ts");
    // No timers anywhere: correctness comes from sharing the promise.
    expect(client).not.toMatch(/setTimeout|setInterval/);
    expect(read("src/components/generate/processing-view.tsx")).not.toMatch(/ADVANCE_GAP_MS/);
  });
});
