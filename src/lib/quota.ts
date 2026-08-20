/**
 * Pure quota arithmetic and the shared safety states.
 *
 * This module holds no Google numbers of its own. Free limits and the reserve
 * are always passed in, sourced from the versioned pricing catalog through the
 * pricing service. What lives here is the *shape* of the calculation, so the
 * server, the `/usage` page, the topbar indicator and the future preflight all
 * agree on what "remaining" means.
 *
 * It is deliberately client-safe: no secrets, no database, no `server-only`.
 */

export type QuotaHealth = "healthy" | "warning" | "exhausted";

/**
 * The four reusable UI states from the product spec. `unverified` is not a
 * quota level -- it means the free limits themselves are unconfirmed, so no
 * Google request may be made regardless of how much quota appears to be left.
 */
export type QuotaState = QuotaHealth | "unverified";

/**
 * Fraction of the usable allowance at which the UI starts warning. A
 * presentation threshold, not a Google billing number, so it belongs here
 * rather than in the pricing catalog.
 */
export const QUOTA_WARNING_RATIO = 0.75;

export type QuotaInput = {
  /** Google's free monthly allowance for the SKU. */
  freeLimit: number;
  /** Safety margin withheld from that allowance. */
  reserve: number;
  /** Calls already counted this billing period. */
  used: number;
};

export type QuotaFigures = {
  freeLimit: number;
  reserve: number;
  used: number;
  /**
   * `freeLimit - reserve`, floored at zero. This is the ceiling that
   * `reserve_api_calls()` enforces in Postgres, and nothing may exceed it.
   */
  effectiveLimit: number;
  /**
   * `freeLimit - used - reserve`, unclamped. Goes negative when the counter has
   * drifted past the protected ceiling (a retried request, a call made with the
   * same key from elsewhere). Kept signed so that drift is visible instead of
   * being rounded away into a comfortable-looking zero.
   */
  protectedRemaining: number;
  /** `protectedRemaining` floored at zero -- what the SQL RPC reports. */
  remaining: number;
  /** Used as a percentage of the usable allowance. Can exceed 100 under drift. */
  percentUsed: number;
  /** Same value clamped to 0-100, for progress bars. */
  percentUsedClamped: number;
  health: QuotaHealth;
};

/**
 * The single definition of "how much is left".
 *
 * Mirrors `public.reserve_api_calls()` exactly:
 *   effective_limit = greatest(free_limit - reserve, 0)
 *   granted         = used + n <= effective_limit
 */
export function deriveQuotaFigures({ freeLimit, reserve, used }: QuotaInput): QuotaFigures {
  const safeFreeLimit = Math.max(freeLimit, 0);
  const safeReserve = Math.max(reserve, 0);
  const safeUsed = Math.max(used, 0);

  const effectiveLimit = Math.max(safeFreeLimit - safeReserve, 0);
  const protectedRemaining = safeFreeLimit - safeUsed - safeReserve;
  const remaining = Math.max(protectedRemaining, 0);

  // A zero usable allowance is fully consumed by definition: there is nothing
  // to spend, so reporting 0% used would invite a request that must not happen.
  const percentUsed = effectiveLimit === 0 ? 100 : (safeUsed / effectiveLimit) * 100;

  return {
    freeLimit: safeFreeLimit,
    reserve: safeReserve,
    used: safeUsed,
    effectiveLimit,
    protectedRemaining,
    remaining,
    percentUsed,
    percentUsedClamped: Math.min(Math.max(percentUsed, 0), 100),
    health:
      remaining <= 0
        ? "exhausted"
        : percentUsed >= QUOTA_WARNING_RATIO * 100
          ? "warning"
          : "healthy",
  };
}

/**
 * Would `n` more calls be granted? Same comparison as the SQL guard, so the UI
 * can predict a denial rather than discovering it mid-run.
 *
 * This is a prediction only. The authoritative answer is always the atomic
 * `reserve_api_calls()` call, which is the one thing that holds a row lock.
 */
export function canAfford(figures: QuotaFigures, n: number): boolean {
  if (n <= 0) return true;
  return figures.used + n <= figures.effectiveLimit;
}

/** How many of `n` requested calls would fit inside the protected allowance. */
export function affordableCalls(figures: QuotaFigures, n: number): number {
  return Math.max(Math.min(n, figures.remaining), 0);
}

/**
 * Merges the quota level with pricing verification into one displayable state.
 *
 * Precedence: exhausted > unverified > warning > healthy. Exhaustion outranks
 * unverified pricing because it is the more specific fact -- both block a
 * request, but only one of them tells you why the run stopped.
 */
export function resolveQuotaState(health: QuotaHealth, pricingVerified: boolean): QuotaState {
  if (health === "exhausted") return "exhausted";
  if (!pricingVerified) return "unverified";
  return health;
}

export type QuotaStateMeta = {
  label: string;
  /** One line, written to be shown directly to the user. */
  description: string;
  /** Tailwind classes for a badge, readable in both themes. */
  badgeClass: string;
  /** Tailwind classes for a progress/meter fill. */
  meterClass: string;
  /** Tailwind text colour for figures that carry the state. */
  textClass: string;
};

export const QUOTA_STATE_META: Record<QuotaState, QuotaStateMeta> = {
  healthy: {
    label: "Free quota available",
    description: "Comfortably inside the protected free allowance.",
    badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    meterClass: "bg-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    label: "Free quota getting low",
    description: "Most of the protected free allowance for this month is spent.",
    badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    meterClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  exhausted: {
    label: "Free plan limit reached",
    description: "No further Google requests will be made until the billing month resets.",
    badgeClass: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    meterClass: "bg-red-500",
    textClass: "text-red-600 dark:text-red-400",
  },
  unverified: {
    label: "Pricing not verified",
    description: "Free limits have not been confirmed against Google Cloud billing.",
    badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    meterClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
  },
};
