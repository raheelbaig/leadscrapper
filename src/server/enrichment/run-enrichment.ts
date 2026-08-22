import "server-only";

import type { Json } from "@/lib/database.types";
import { getSupabaseAdminClient } from "@/server/db/admin";

import { EmailEnrichmentService } from "./email-enrichment-service";
import {
  canAttempt,
  clampBatch,
  eligibleStatuses,
  estimateMaxRequests,
  MAX_ENRICHMENT_BATCH,
  type EnrichmentMode,
} from "./enrichment-policy";
import { WebsiteEmailProvider } from "./providers/website-provider";
import { domainOf, type FetchImpl } from "./providers/website-fetcher";
import type { EmailStatus, EnrichmentInput, EnrichmentResult } from "./types";

/**
 * Running enrichment over a bounded batch of leads.
 *
 * FOUR properties this deliberately does NOT have:
 *
 *   1. It is not automatic. Nothing schedules it, no cron job drives it, and
 *      the search tick cannot reach it — an ESLint boundary forbids the import
 *      and the safety envelope asserts it independently.
 *   2. It is not unbounded. `limit` is capped hard, and a run that would touch
 *      more leads than that processes the cap and reports what it left.
 *   3. It is not concurrent. Leads are processed one at a time with a politeness
 *      delay between hosts. Speed here is worth nothing and rudeness to a small
 *      business's web host is worth less than nothing.
 *   4. It does not default its `fetchImpl`. The caller passes one explicitly,
 *      which is what makes `dryRun` genuinely inert rather than nearly inert.
 *
 * `dryRun` resolves which leads WOULD be enriched and writes nothing at all —
 * no request, no lead update, no attempt row. It is the pre-flight for this
 * subsystem, and it is what was used during implementation.
 */

type AdminDb = ReturnType<typeof getSupabaseAdminClient>;

/** Gap between leads, on top of the provider's own per-host delay. */
export const BETWEEN_LEADS_MS = 500;

/** Re-exported so callers need one import for the whole enrichment contract. */
export {
  MAX_ATTEMPTS_PER_LEAD,
  MAX_ENRICHMENT_BATCH,
  REQUESTS_PER_LEAD,
  estimateMaxRequests,
  type EnrichmentMode,
} from "./enrichment-policy";

export class EnrichmentError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "EnrichmentError";
    this.status = status;
  }
}

export type EnrichmentCandidateLead = {
  id: string;
  name: string;
  website: string | null;
  city: string | null;
  country: string | null;
};

export type LeadEnrichmentOutcome = {
  leadId: string;
  name: string;
  status: EmailStatus;
  email: string | null;
  confidence: number | null;
  error: string | null;
  durationMs: number;
};

/**
 * What a batch WOULD do, shown before anything is requested.
 *
 * This is the shape the confirmation dialog is built from. A person approving a
 * run should see the largest number it could reach, not an average.
 */
export type EnrichmentScope = {
  mode: EnrichmentMode;
  /** Leads matching the mode that still have attempts left. */
  eligible: number;
  /** How many of those this batch will take, after the cap. */
  selected: number;
  /** All of them have websites -- a lead without one is never selectable. */
  withWebsite: number;
  /** Worst case: robots.txt plus four pages, for every selected lead. */
  maxExternalRequests: number;
  provider: string;
  /** Leads are processed one at a time, never in parallel. */
  concurrency: number;
  batchCap: number;
  /** Eligible leads this batch will NOT reach. */
  remaining: number;
  /** Leads excluded, and why -- so a skipped lead is never silent. */
  skipped: { leadId: string; name: string; reason: string }[];
};

export type EnrichmentRunResult = {
  dryRun: boolean;
  mode: EnrichmentMode;
  /** Leads that had a usable website and were in scope for this run. */
  selected: number;
  processed: number;
  found: number;
  notFound: number;
  failed: number;
  /** Eligible leads still awaiting a look after this run. */
  remaining: number;
  scope: EnrichmentScope;
  results: LeadEnrichmentOutcome[];
};

/** A lead row plus the two facts the policy needs to judge it. */
type CandidateRow = EnrichmentCandidateLead & {
  email_status: EmailStatus;
};

/**
 * Leads this batch may attempt.
 *
 * The MODE decides which `email_status` values are in play, and it is enforced
 * in the query AND re-checked per lead by `canAttempt`. `leadIds` NARROWS that
 * set; it never widens it. Naming a `found` lead in a retry batch selects
 * nothing, because a mis-click must not be able to overwrite an address that
 * was already discovered.
 *
 * Leads at the attempt cap are dropped here, which is what stops "retry failed"
 * from being an endless loop a person can hold down.
 */
async function selectCandidates(
  db: AdminDb,
  args: {
    userId: string;
    mode: EnrichmentMode;
    searchId?: string;
    leadIds?: string[];
    limit: number;
  },
): Promise<{
  leads: EnrichmentCandidateLead[];
  scope: Omit<EnrichmentScope, "provider" | "concurrency" | "batchCap" | "maxExternalRequests">;
}> {
  let query = db
    .from("leads")
    .select("id, name, website, city, country, email_status")
    .eq("user_id", args.userId)
    .not("website", "is", null)
    .neq("website", "")
    .in("email_status", eligibleStatuses(args.mode));

  if (args.leadIds && args.leadIds.length > 0) query = query.in("id", args.leadIds);
  if (args.searchId) query = query.eq("search_id", args.searchId);

  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) throw new Error(`Could not select leads for enrichment: ${error.message}`);

  const rows = (data ?? []) as CandidateRow[];

  // Attempt history for exactly these leads, counted in memory. The set is
  // bounded by the candidate pool, and Postgrest has no group-by worth the
  // round trip here.
  const attemptCounts = new Map<string, number>();
  if (rows.length > 0) {
    const { data: attempts } = await db
      .from("lead_enrichment_attempts")
      .select("lead_id")
      .in(
        "lead_id",
        rows.map((r) => r.id),
      );

    for (const a of attempts ?? []) {
      attemptCounts.set(a.lead_id, (attemptCounts.get(a.lead_id) ?? 0) + 1);
    }
  }

  const eligible: EnrichmentCandidateLead[] = [];
  const skipped: EnrichmentScope["skipped"] = [];

  for (const row of rows) {
    const decision = canAttempt({
      mode: args.mode,
      status: row.email_status,
      website: row.website,
      attemptCount: attemptCounts.get(row.id) ?? 0,
    });

    if (decision.eligible) {
      eligible.push({
        id: row.id,
        name: row.name,
        website: row.website,
        city: row.city,
        country: row.country,
      });
    } else {
      skipped.push({ leadId: row.id, name: row.name, reason: decision.reason });
    }
  }

  const selected = eligible.slice(0, args.limit);

  return {
    leads: selected,
    scope: {
      mode: args.mode,
      eligible: eligible.length,
      selected: selected.length,
      withWebsite: selected.length,
      remaining: Math.max(eligible.length - selected.length, 0),
      skipped,
    },
  };
}

function toInput(lead: EnrichmentCandidateLead): EnrichmentInput {
  return {
    leadId: lead.id,
    businessName: lead.name,
    website: lead.website,
    domain: lead.website ? domainOf(lead.website) : null,
    city: lead.city,
    country: lead.country,
  };
}

/**
 * Persist one result.
 *
 * The `leads_email_null_until_enriched` CHECK forbids a non-null email while
 * the status is still `not_enriched`, so the email and the status move in the
 * SAME statement. Writing them separately would be rejected by the database,
 * which is the constraint doing exactly its job.
 */
async function persist(
  db: AdminDb,
  args: {
    userId: string;
    lead: EnrichmentCandidateLead;
    result: EnrichmentResult;
    durationMs: number;
  },
): Promise<LeadEnrichmentOutcome> {
  const best = args.result.candidates[0] ?? null;
  const checkedAt = new Date().toISOString();

  const { error: updateError } = await db
    .from("leads")
    .update({
      email: best?.email ?? null,
      email_status: args.result.status,
      email_source: best?.source ?? null,
      email_confidence: best?.confidence ?? null,
      email_checked_at: checkedAt,
    })
    .eq("id", args.lead.id)
    .eq("user_id", args.userId);

  if (updateError) throw new Error(`Could not save the enrichment result: ${updateError.message}`);

  // The attempt ledger records what happened even when nothing was found, so a
  // lead that has been looked at is distinguishable from one that has not.
  const { error: attemptError } = await db.from("lead_enrichment_attempts").insert({
    user_id: args.userId,
    lead_id: args.lead.id,
    provider: "website",
    status: args.result.status,
    email: best?.email ?? null,
    confidence: best?.confidence ?? null,
    cost_sku: "website-scrape",
    cost_units: 0,
    duration_ms: args.durationMs,
    error: args.result.error?.slice(0, 500) ?? null,
    raw: {
      candidates: args.result.candidates.map((c) => ({
        email: c.email,
        confidence: c.confidence,
        source: c.source,
      })),
    } as unknown as Json,
  });

  if (attemptError) {
    console.error(`lead_enrichment_attempts insert failed: ${attemptError.message}`);
  }

  return {
    leadId: args.lead.id,
    name: args.lead.name,
    status: args.result.status,
    email: best?.email ?? null,
    confidence: best?.confidence ?? null,
    error: args.result.error ?? null,
    durationMs: args.durationMs,
  };
}

export async function runEnrichment(
  args: {
    userId: string;
    /**
     * `new` looks at leads never checked. `retry-failed` looks ONLY at leads
     * whose last attempt failed, and cannot reach any other status.
     */
    mode?: EnrichmentMode;
    searchId?: string;
    leadIds?: string[];
    limit?: number;
    dryRun: boolean;
    /**
     * REQUIRED for a live run. There is no default: a forgotten stub must be a
     * type error, not a silent request to somebody's website.
     */
    fetchImpl?: FetchImpl;
    sleep?: (ms: number) => Promise<void>;
  },
  db: AdminDb = getSupabaseAdminClient(),
): Promise<EnrichmentRunResult> {
  const mode: EnrichmentMode = args.mode ?? "new";
  const limit = clampBatch(args.limit);

  const { leads, scope: partial } = await selectCandidates(db, {
    userId: args.userId,
    mode,
    searchId: args.searchId,
    leadIds: args.leadIds,
    limit,
  });

  const scope: EnrichmentScope = {
    ...partial,
    maxExternalRequests: estimateMaxRequests(leads.length),
    provider: "website",
    concurrency: 1,
    batchCap: MAX_ENRICHMENT_BATCH,
  };

  // ---- dry run: resolve the scope, touch nothing ------------------------
  if (args.dryRun) {
    return {
      dryRun: true,
      mode,
      selected: leads.length,
      processed: 0,
      found: 0,
      notFound: 0,
      failed: 0,
      remaining: scope.remaining,
      scope,
      results: leads.map((lead) => ({
        leadId: lead.id,
        name: lead.name,
        status: "not_enriched" as EmailStatus,
        email: null,
        confidence: null,
        error: null,
        durationMs: 0,
      })),
    };
  }

  if (!args.fetchImpl) {
    throw new EnrichmentError(
      "A live enrichment run needs an explicit fetch implementation. Refusing to guess one.",
      500,
    );
  }

  const service = new EmailEnrichmentService();
  service.register(new WebsiteEmailProvider({ fetchImpl: args.fetchImpl, sleep: args.sleep }));

  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const results: LeadEnrichmentOutcome[] = [];

  // Sequential on purpose. See the module comment.
  for (const [index, lead] of leads.entries()) {
    if (index > 0) await sleep(BETWEEN_LEADS_MS);

    const startedAt = Date.now();
    let result: EnrichmentResult;
    try {
      result = await service.enrich(toInput(lead));
    } catch (error) {
      result = {
        status: "failed",
        candidates: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    results.push(
      await persist(db, {
        userId: args.userId,
        lead,
        result,
        durationMs: Date.now() - startedAt,
      }),
    );
  }

  return {
    dryRun: false,
    mode,
    selected: leads.length,
    processed: results.length,
    found: results.filter((r) => r.status === "found" || r.status === "verified").length,
    notFound: results.filter((r) => r.status === "not_found").length,
    failed: results.filter((r) => r.status === "failed").length,
    remaining: scope.remaining,
    scope,
    results,
  };
}
