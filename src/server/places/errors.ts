import "server-only";

/**
 * The error taxonomy for Google Places requests.
 *
 * The only distinction that really matters is RETRYABLE vs NOT, because a retry
 * is a second billable request. Retrying a 400 would spend the free allowance
 * re-sending a request Google has already told us is malformed, three times, and
 * still fail -- so the classification here is a cost decision as much as a
 * correctness one.
 */

export type PlacesFailureKind =
  /** No HTTP status ever arrived: DNS, connection reset, abort, timeout. */
  | "network"
  /** Google answered, but not with 2xx. */
  | "http"
  /** 2xx whose body did not match the documented response shape. */
  | "malformed";

export class PlacesApiError extends Error {
  readonly kind: PlacesFailureKind;
  readonly status: number | null;
  /** Google's `error.status`, e.g. INVALID_ARGUMENT / RESOURCE_EXHAUSTED. */
  readonly googleStatus: string | null;
  readonly retryable: boolean;
  /**
   * Did the request reach Google and produce an HTTP status? If so it may have
   * been metered on their side, and the reservation must NOT be refunded.
   */
  readonly reachedGoogle: boolean;

  constructor(args: {
    message: string;
    kind: PlacesFailureKind;
    status?: number | null;
    googleStatus?: string | null;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "PlacesApiError";
    this.kind = args.kind;
    this.status = args.status ?? null;
    this.googleStatus = args.googleStatus ?? null;
    this.retryable = args.retryable;
    this.reachedGoogle = args.kind !== "network";
  }

  /** A short, user-facing line for the search activity log. */
  get logMessage(): string {
    if (this.kind === "network") return `Network error reaching Google: ${this.message}`;
    if (this.kind === "malformed") return `Google returned an unexpected response shape`;
    return `Google returned HTTP ${this.status}${this.googleStatus ? ` (${this.googleStatus})` : ""}: ${this.message}`;
  }
}

/**
 * Which HTTP statuses are worth a second request?
 *
 *   429  rate limited -- the canonical retryable case, and free to retry
 *        because Google does not bill a throttled request
 *   5xx  Google's fault, and transient by definition
 *
 * Everything else is a request WE got wrong and would get wrong again:
 *   400  malformed body or field mask
 *   401  missing or invalid API key
 *   403  key restrictions, or the API not enabled on the project
 *   404  wrong endpoint
 *
 * Retrying those burns the free allowance to receive the identical rejection.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** A message the user can act on, per status. */
export function describeStatus(status: number, googleMessage: string): string {
  switch (status) {
    case 400:
      return `Google rejected the request as invalid. This is a bug in the request body or field mask, not a transient failure. ${googleMessage}`;
    case 401:
      return `Google rejected the API key. Check GOOGLE_MAPS_API_KEY in .env.local. ${googleMessage}`;
    case 403:
      return `Google refused the request. The key's restrictions may not allow this API, or the Places API (New) may not be enabled on the project. ${googleMessage}`;
    case 404:
      return `Google returned 404 for the Text Search endpoint. ${googleMessage}`;
    case 429:
      return `Google rate-limited the request. ${googleMessage}`;
    default:
      return status >= 500
        ? `Google had a server error. ${googleMessage}`
        : `Google returned HTTP ${status}. ${googleMessage}`;
  }
}
