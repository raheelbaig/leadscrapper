import "server-only";

import type { EmailProvider, EnrichmentInput, EnrichmentResult } from "./types";

/**
 * Inert by design.
 *
 * The registry is empty and this class is never constructed anywhere in the
 * application. It exists so that Phase 7 can add providers without touching a
 * single line of the Places, grid, or coverage code.
 *
 * Adding a provider is a deliberate, reviewed decision: it is the moment this
 * application starts making requests to a host that is not Google.
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
    if (this.providers.length === 0) {
      return { status: "not_enriched", candidates: [] };
    }

    if (!input.website && !input.domain) {
      // Without a website there is no path to an email at all.
      return { status: "not_found", candidates: [] };
    }

    throw new Error(
      "EmailEnrichmentService.enrich is not implemented. Providers must be chosen and approved before any third-party request is made.",
    );
  }
}
