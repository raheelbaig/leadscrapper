import "server-only";

/**
 * Email enrichment: the interface boundary only.
 *
 * The Google Places API returns no email address in any field, tier, or
 * endpoint. `Lead.website` is the bridge: a domain is the only starting point
 * Google gives us for finding a contact address.
 *
 * Nothing in src/server/{places,geo,grid,coverage,search,export} may import
 * this module, and that is enforced by an ESLint boundary rule rather than by
 * convention. No provider is registered, so no request is made to any host
 * other than Google's API endpoints.
 */

export type EmailStatus =
  | "not_enriched"
  | "queued"
  | "found"
  | "verified"
  | "unverified"
  | "not_found"
  | "failed";

export type EmailCandidate = {
  email: string;
  /** 0..1 -- how much this provider trusts the address. */
  confidence: number;
  source: string;
  verified: boolean;
  meta?: Record<string, unknown>;
};

export type EnrichmentInput = {
  leadId: string;
  businessName: string;
  website: string | null;
  domain: string | null;
  city: string | null;
  country: string | null;
};

export type EnrichmentResult = {
  status: EmailStatus;
  candidates: EmailCandidate[];
  error?: string;
};

/**
 * Every provider declares its cost against a SKU so it can be metered through
 * the same quota service the Google calls use. Free-limit protection then
 * extends to any paid email API automatically, rather than being reinvented.
 */
export type ProviderCost = {
  sku: string;
  units: number;
};

export interface EmailProvider {
  readonly name: string;
  /** Cheap providers run before expensive ones. */
  readonly order: number;
  costPerLookup(): ProviderCost;
  canHandle(input: EnrichmentInput): boolean;
  find(input: EnrichmentInput): Promise<EnrichmentResult>;
}
