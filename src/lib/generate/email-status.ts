/**
 * Email outcomes in the words a business owner would use.
 *
 * The database enum is precise and stays exactly as it is -- `not_enriched`,
 * `found`, `verified`, `unverified`, `not_found`, `failed` are all meaningfully
 * different and the export, the advanced Enrichment page and the technical
 * details all keep using them. What a normal user needs is not that vocabulary
 * but the four distinctions that change what they would DO:
 *
 *   we have an address            -> use it
 *   we looked and there was none  -> stop hoping; the site publishes no email
 *   we could not look             -> the site blocked or never answered
 *   we have not looked yet        -> it is still coming
 *
 * `verified` and `unverified` both collapse into "Email found" deliberately.
 * Nothing in this product ever asks a mail server, so no address it reports has
 * been verified in the sense a user would assume from the word -- and the
 * enrichment provider is careful never to claim otherwise.
 */

export type FriendlyEmailStatus = {
  label: string;
  /** One line of explanation, for a tooltip or a details row. */
  detail: string;
  tone: "positive" | "neutral" | "warning";
};

const FRIENDLY: Record<string, FriendlyEmailStatus> = {
  found: {
    label: "Email found",
    detail: "We found a contact address on this business's own website.",
    tone: "positive",
  },
  verified: {
    label: "Email found",
    detail: "We found a contact address on this business's own website.",
    tone: "positive",
  },
  unverified: {
    label: "Email found",
    detail: "We found a contact address on this business's own website.",
    tone: "positive",
  },
  not_found: {
    label: "No public email found",
    detail: "We checked their website and it does not publish a contact address.",
    tone: "neutral",
  },
  failed: {
    label: "Could not check website",
    detail: "Their website blocked us or did not respond. You can try again.",
    tone: "warning",
  },
  queued: {
    label: "Not checked yet",
    detail: "This business is waiting to be checked.",
    tone: "neutral",
  },
  not_enriched: {
    label: "Not checked",
    detail: "We have not looked at this business's website yet.",
    tone: "neutral",
  },
};

const UNKNOWN: FriendlyEmailStatus = {
  label: "Not checked",
  detail: "We have not looked at this business's website yet.",
  tone: "neutral",
};

export function friendlyEmailStatus(status: string): FriendlyEmailStatus {
  return FRIENDLY[status] ?? UNKNOWN;
}

/** The filter groups the results table offers, in the order they are shown. */
export const EMAIL_FILTERS = [
  { id: "all", label: "All" },
  { id: "with-email", label: "With email" },
  { id: "no-email", label: "No email found" },
  { id: "unchecked", label: "Not checked" },
] as const;

export type EmailFilterId = (typeof EMAIL_FILTERS)[number]["id"];

export function matchesEmailFilter(
  filter: EmailFilterId,
  lead: { email: string | null; emailStatus: string },
): boolean {
  switch (filter) {
    case "with-email":
      return Boolean(lead.email);
    case "no-email":
      return !lead.email && (lead.emailStatus === "not_found" || lead.emailStatus === "failed");
    case "unchecked":
      return lead.emailStatus === "not_enriched" || lead.emailStatus === "queued";
    case "all":
    default:
      return true;
  }
}
