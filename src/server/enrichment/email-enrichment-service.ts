import "server-only";

import type { EmailProvider, EnrichmentInput, EnrichmentResult } from "./types";

/**
 * The provider chain.
 *
 * Providers run cheapest-first and the chain stops at the first one that
 * returns an address. Today there is exactly one — `WebsiteEmailProvider`,
 * which reads the business's own public site and costs nothing. A paid API
 * added later slots in behind it by `order` and meters through the same quota
 * service, so free-limit protection extends to it automatically rather than
 * being reinvented.
 *
 * The registry is still EMPTY BY DEFAULT and this class is never constructed
 * with a provider except by an explicit, user-triggered enrichment run. Nothing
 * on the search path may import it — enforced by an ESLint boundary and by the
 * safety envelope.
 */
export class EmailEnrichmentService {
  private readonly providers: EmailProvider[] = [];

  register(provider: EmailProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.order - b.order);
  }

  get registered(): readonly string[] {
    return this.providers.map((p) => p.name);
  }

  async enrich(input: EnrichmentInput): Promise<EnrichmentResult> {
    // No provider registered means nothing was attempted. That is a different
    // fact from "looked and found nothing", and the status keeps them apart.
    if (this.providers.length === 0) {
      return { status: "not_enriched", candidates: [] };
    }

    if (!input.website && !input.domain) {
      // Without a website there is no path to an email at all.
      return { status: "not_found", candidates: [] };
    }

    const errors: string[] = [];
    let sawAnAttempt = false;

    for (const provider of this.providers) {
      if (!provider.canHandle(input)) continue;
      sawAnAttempt = true;

      try {
        const result = await provider.find(input);
        if (result.status === "found" || result.status === "verified") return result;
        if (result.error) errors.push(`${provider.name}: ${result.error}`);
      } catch (error) {
        // One provider throwing must not abandon the rest of the chain, but it
        // must be reported rather than swallowed into a bare "not found".
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!sawAnAttempt) {
      return { status: "not_found", candidates: [], error: "No provider could handle this lead." };
    }

    return errors.length > 0
      ? { status: "failed", candidates: [], error: errors.join("; ") }
      : { status: "not_found", candidates: [] };
  }
}
