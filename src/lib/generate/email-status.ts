/**
 * Email outcomes in the words a business owner would use.
 *
 * The database enum is precise and stays exactly as it is -- `not_enriched`,
 * `found`, `verified`, `unverified`, `not_found`, `failed` are all meaningfully
 * different and the export, the advanced Enrichment page and the technical
 * details all keep using them. What a normal user needs is not that vocabulary
 * but the distinctions that change what they would DO.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WEBSITE MATTERS TO THE LABEL.
 *
 * `not_enriched` means two completely different things depending on whether the
 * business has a website:
 *
 *   WITH a website    -- we have not looked yet. Real pending work, and the
 *                        generation is not finished while any of these remain.
 *   WITHOUT a website -- there is nothing to look at. Google returns no email
 *                        at any tier and the site is the only bridge to one, so
 *                        this lead is already as finished as it can be.
 *
 * Labelling both "Not checked" made a completed run look abandoned. A real
 * generation ended with 204 found, 111 with no public address and 77
 * unreachable -- 392, every one of the leads that had a website -- and 93
 * website-less leads reading "Not checked". Summing the first three left 93
 * apparently outstanding, so a finished run looked like it had stopped early.
 *
 * The status alone cannot say which case it is, so the label takes the website
 * too.
 * ---------------------------------------------------------------------------
 */

export type FriendlyEmailStatus = {
  label: string;
  /** One line of explanation, for a tooltip or a details row. */
  detail: string;
  tone: "positive" | "neutral" | "warning";
  /** False when nothing further can be done for this lead. */
  pending: boolean;
};

const FOUND: FriendlyEmailStatus = {
  label: "Email found",
  detail: "We found a contact address on this business's own website.",
  tone: "positive",
  pending: false,
};

const FRIENDLY: Record<string, FriendlyEmailStatus> = {
  found: FOUND,
  verified: FOUND,
  unverified: FOUND,
  not_found: {
    label: "No public email",
    detail: "We checked their website and it does not publish a contact address.",
    tone: "neutral",
    pending: false,
  },
  failed: {
    label: "Could not check",
    detail: "Their website blocked us or did not respond. You can try again.",
    tone: "warning",
    pending: false,
  },
  queued: {
    label: "Not checked",
    detail: "This business is waiting to be checked.",
    tone: "neutral",
    pending: true,
  },
  not_enriched: {
    label: "Not checked",
    detail: "We have not looked at this business's website yet.",
    tone: "neutral",
    pending: true,
  },
};

/**
 * The one outcome that is about the lead rather than about our looking.
 *
 * Terminal, and deliberately worded so it cannot be mistaken for pending work.
 */
const NO_WEBSITE: FriendlyEmailStatus = {
  label: "No website",
  detail:
    "This business has no website listed, and a website is the only place a public email could be found. There is nothing to check.",
  tone: "neutral",
  pending: false,
};

export function friendlyEmailStatus(status: string, hasWebsite = true): FriendlyEmailStatus {
  // A lead with no website can never be looked at, whatever its stored status.
  if (!hasWebsite && (status === "not_enriched" || status === "queued")) return NO_WEBSITE;

  return FRIENDLY[status] ?? FRIENDLY.not_enriched;
}

/** Whether this lead still represents outstanding enrichment work. */
export function isEnrichmentPending(status: string, hasWebsite: boolean): boolean {
  return friendlyEmailStatus(status, hasWebsite).pending;
}

/** The filter groups the results table offers, in the order they are shown. */
export const EMAIL_FILTERS = [
  { id: "all", label: "All" },
  { id: "with-email", label: "With email" },
  { id: "no-email", label: "No email found" },
  { id: "no-website", label: "No website" },
  { id: "unchecked", label: "Not checked" },
] as const;

export type EmailFilterId = (typeof EMAIL_FILTERS)[number]["id"];

export function matchesEmailFilter(
  filter: EmailFilterId,
  lead: { email: string | null; emailStatus: string; website: string | null },
): boolean {
  const hasWebsite = Boolean(lead.website && lead.website.trim() !== "");

  switch (filter) {
    case "with-email":
      return Boolean(lead.email);
    case "no-email":
      return !lead.email && (lead.emailStatus === "not_found" || lead.emailStatus === "failed");
    case "no-website":
      return !hasWebsite;
    case "unchecked":
      // GENUINELY pending only. A website-less lead is not waiting for anything.
      return hasWebsite && (lead.emailStatus === "not_enriched" || lead.emailStatus === "queued");
    case "all":
    default:
      return true;
  }
}
