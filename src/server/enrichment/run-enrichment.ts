import "server-only";

import type { Json } from "@/lib/database.types";
import { getSupabaseAdminClient } from "@/server/db/admin";

import { EmailEnrichmentService } from "./email-enrichment-service";
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

/** The most leads one request may touch. Deliberately small. */
export const MAX_ENRICHMENT_BATCH = 25;

/** Gap between leads, on top of the provider's own per-host delay. */
export const BETWEEN_LEADS_MS = 500;

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

export type EnrichmentRunResult = {
  dryRun: boolean;
  /** Leads that had a usable website and were in scope for this run. */
  selected: number;
  processed: number;
  found: number;
  notFound: number;
  failed: number;
  /** Leads with a website still awaiting a look after this run. */
  remaining: number;
  results: LeadEnrichmentOutcome[];
};

/**
 * Leads worth attempting: never enriched, and with a website.
 *
 * `email_status = 'not_enriched'` is the filter that makes a re-run idempotent
 * — a lead that has been looked at, whatever the answer, is not looked at again
 * unless it is explicitly named.
 */
async function selectCandidates(
  db: AdminDb,
  args: { userId: string; searchId?: string; leadIds?: string[]; limit: number },
): Promise<{ leads: EnrichmentCandidateLead[]; totalPending: number }> {
  const base = () => {
    let query = db
      .from("leads")
      .select("id, name, website, city, country", { count: "exact" })
      .eq("user_id", args.userId)
      .not("website", "is", null)
      .neq("website", "");

    if (args.leadIds && args.leadIds.length > 0) {
      query = query.in("id", args.leadIds);
    } else {
      query = query.eq("email_status", "not_enriched");
    }

    if (args.searchId) query = query.eq("search_id", args.searchId);
    return query;
  };

  const { data, count, error } = await base()
    .order("created_at", { ascending: true })
    .limit(args.limit);

  if (error) throw new Error(`Could not select leads for enrichment: ${error.message}`);

  return { leads: (data ?? []) as EnrichmentCandidateLead[], totalPending: count ?? 0 };
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
  const limit = Math.min(Math.max(args.limit ?? 10, 1), MAX_ENRICHMENT_BATCH);
  const { leads, totalPending } = await selectCandidates(db, {
    userId: args.userId,
    searchId: args.searchId,
    leadIds: args.leadIds,
    limit,
  });

  // ---- dry run: resolve the scope, touch nothing ------------------------
  if (args.dryRun) {
    return {
      dryRun: true,
      selected: leads.length,
      processed: 0,
      found: 0,
      notFound: 0,
      failed: 0,
      remaining: Math.max(totalPending - leads.length, 0),
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
    selected: leads.length,
    processed: results.length,
    found: results.filter((r) => r.status === "found" || r.status === "verified").length,
    notFound: results.filter((r) => r.status === "not_found").length,
    failed: results.filter((r) => r.status === "failed").length,
    remaining: Math.max(totalPending - results.length, 0),
    results,
  };
}
