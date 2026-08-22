import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MAX_ATTEMPTS_PER_LEAD } from "./enrichment-policy";

/**
 * Retry selection against the REAL database. OPT-IN:
 *
 *     LEAD_SCRAPPER_DB_TESTS=1 npx vitest run src/server/enrichment/retry.db.test.ts
 *
 * The unit tests pin the RULES; this pins that the QUERY implements them. The
 * selection is a Postgrest filter plus an attempt count, and a mock would only
 * prove the mock agrees with itself.
 *
 * It runs entirely in dryRun, so it makes NO external request of any kind — the
 * point under test is who gets selected, not what their websites say.
 *
 * It creates its own throwaway search and leads and deletes them afterwards.
 * The real Phase 3A/3B leads are never selected, never modified, and are
 * asserted untouched at the end.
 */

const ENABLED = process.env.LEAD_SCRAPPER_DB_TESTS === "1";

type Db = ReturnType<typeof import("@/server/db/admin").getSupabaseAdminClient>;

describe.skipIf(!ENABLED)("retry selection", () => {
  let db: Db;
  let userId: string;
  let searchId: string;
  const leadIds: Record<string, string> = {};
  let realLeadsBefore: unknown;

  beforeAll(async () => {
    const { getSupabaseAdminClient } = await import("@/server/db/admin");
    db = getSupabaseAdminClient();

    const { data: anySearch } = await db.from("searches").select("*").limit(1).single();
    userId = anySearch!.user_id;

    const { data: realLeads } = await db.from("leads").select("*").order("id");
    realLeadsBefore = realLeads;

    // A throwaway search to hang the fixtures off. Never run, never billed.
    const { data: search, error } = await db
      .from("searches")
      .insert({
        user_id: userId,
        niche: "Retry Fixture",
        query_text: "Retry Fixture",
        country: "Testland",
        city: "Fixtureville",
        label: "retry fixture — deleted by the test",
        min_lat: 0,
        min_lng: 0,
        max_lat: 0.01,
        max_lng: 0.01,
        target_leads: 1,
        grid_config: {},
        grid_key: `retry-fixture-${Date.now()}`,
        pricing_version: "test",
        field_mask: ["places.id"],
        search_sku: "places-text-search-enterprise",
        status: "draft",
      })
      .select("id")
      .single();

    if (error) throw new Error(`fixture search: ${error.message}`);
    searchId = search!.id;

    // One lead per interesting state.
    const fixtures = [
      { key: "failed", status: "failed", website: "https://failed.test", email: null },
      { key: "failedTwice", status: "failed", website: "https://failed-twice.test", email: null },
      { key: "exhausted", status: "failed", website: "https://exhausted.test", email: null },
      { key: "found", status: "found", website: "https://found.test", email: "a@found.test" },
      { key: "fresh", status: "not_enriched", website: "https://fresh.test", email: null },
      { key: "noWebsite", status: "failed", website: null, email: null },
    ] as const;

    for (const f of fixtures) {
      const { data, error: insertError } = await db
        .from("leads")
        .insert({
          user_id: userId,
          search_id: searchId,
          place_id: `retry-fixture-${f.key}-${Date.now()}`,
          name: `Fixture ${f.key}`,
          website: f.website,
          email: f.email,
          email_status: f.status,
          email_checked_at: f.status === "not_enriched" ? null : new Date().toISOString(),
        })
        .select("id")
        .single();

      if (insertError) throw new Error(`fixture lead ${f.key}: ${insertError.message}`);
      leadIds[f.key] = data!.id;
    }

    // Attempt history: one for failedTwice's sibling, and a full set for the
    // lead that must be retired.
    const attempts: { lead_id: string; n: number }[] = [
      { lead_id: leadIds.failedTwice, n: 1 },
      { lead_id: leadIds.exhausted, n: MAX_ATTEMPTS_PER_LEAD },
    ];

    for (const a of attempts) {
      for (let i = 0; i < a.n; i += 1) {
        await db.from("lead_enrichment_attempts").insert({
          user_id: userId,
          lead_id: a.lead_id,
          provider: "website",
          status: "failed",
          cost_sku: "website-scrape",
          cost_units: 0,
        });
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (searchId) await db.from("searches").delete().eq("id", searchId);
  }, 60_000);

  async function scopeFor(mode: "new" | "retry-failed", leadIdList?: string[]) {
    const { runEnrichment } = await import("./run-enrichment");
    return runEnrichment({
      userId,
      mode,
      searchId,
      leadIds: leadIdList,
      limit: 25,
      dryRun: true, // no fetchImpl: a live run would throw rather than guess one
    });
  }

  it("bulk retry selects the failed leads and nothing else", async () => {
    const run = await scopeFor("retry-failed");
    const selected = run.results.map((r) => r.leadId).sort();

    expect(selected).toEqual([leadIds.failed, leadIds.failedTwice].sort());
    expect(run.mode).toBe("retry-failed");
  });

  it("bulk retry never selects a lead where an address was found", async () => {
    const run = await scopeFor("retry-failed");
    expect(run.results.map((r) => r.leadId)).not.toContain(leadIds.found);
  });

  it("bulk retry never selects a lead that was never checked", async () => {
    const run = await scopeFor("retry-failed");
    expect(run.results.map((r) => r.leadId)).not.toContain(leadIds.fresh);
  });

  it("retires a lead that has reached the attempt cap", async () => {
    const run = await scopeFor("retry-failed");

    expect(run.results.map((r) => r.leadId)).not.toContain(leadIds.exhausted);

    const skipped = run.scope.skipped.find((s) => s.leadId === leadIds.exhausted);
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/already attempted 3 time\(s\); the cap is 3/);
  });

  it("never selects a failed lead with no website", async () => {
    const run = await scopeFor("retry-failed");
    expect(run.results.map((r) => r.leadId)).not.toContain(leadIds.noWebsite);
  });

  it("per-lead retry selects exactly the named lead", async () => {
    const run = await scopeFor("retry-failed", [leadIds.failed]);

    expect(run.results).toHaveLength(1);
    expect(run.results[0].leadId).toBe(leadIds.failed);
  });

  it("per-lead retry REFUSES a named lead that is not failed", async () => {
    // Naming an id is a request, not an override. A mis-click must not be able
    // to overwrite a discovered address.
    const run = await scopeFor("retry-failed", [leadIds.found]);

    expect(run.results).toHaveLength(0);
    expect(run.selected).toBe(0);
  });

  it("per-lead retry REFUSES a named lead at the attempt cap", async () => {
    const run = await scopeFor("retry-failed", [leadIds.exhausted]);

    expect(run.results).toHaveLength(0);
    expect(run.scope.skipped.map((s) => s.leadId)).toContain(leadIds.exhausted);
  });

  it("a new batch selects only the never-checked lead", async () => {
    const run = await scopeFor("new");

    expect(run.results.map((r) => r.leadId)).toEqual([leadIds.fresh]);
  });

  it("reports a scope the confirmation dialog can be built from", async () => {
    const run = await scopeFor("retry-failed");

    expect(run.scope.provider).toBe("website");
    expect(run.scope.concurrency).toBe(1);
    expect(run.scope.batchCap).toBe(25);
    expect(run.scope.withWebsite).toBe(run.scope.selected);
    expect(run.scope.maxExternalRequests).toBe(run.scope.selected * 5);
  });

  it("clamps the batch below what was asked for", async () => {
    const { runEnrichment } = await import("./run-enrichment");
    const run = await runEnrichment({
      userId,
      mode: "retry-failed",
      searchId,
      limit: 1,
      dryRun: true,
    });

    expect(run.selected).toBe(1);
    // The one it could not take is reported rather than forgotten.
    expect(run.remaining).toBe(1);
  });

  it("made no request and wrote nothing to the real leads", async () => {
    const { data: realLeadsNow } = await db
      .from("leads")
      .select("*")
      .neq("search_id", searchId)
      .order("id");
    expect(realLeadsNow).toEqual(realLeadsBefore);
  });
});
