import { describe, expect, it } from "vitest";

import {
  EMAIL_FILTERS,
  friendlyEmailStatus,
  isEnrichmentPending,
  matchesEmailFilter,
} from "./email-status";

/**
 * What "not checked" means, and why the website decides it.
 *
 * A finished generation reported 204 found, 111 with no public address, 77
 * unreachable and 93 "Not checked". The first three sum to 392 -- every lead
 * that had a website -- and all 93 of the rest had no website at all. Nothing
 * was outstanding, but the label said otherwise and the run looked abandoned.
 */

describe("friendlyEmailStatus", () => {
  it("calls a website-less lead what it is, not 'not checked'", () => {
    const meta = friendlyEmailStatus("not_enriched", false);

    expect(meta.label).toBe("No website");
    // THE POINT: it is finished, not waiting.
    expect(meta.pending).toBe(false);
    expect(meta.detail).toMatch(/nothing to check/i);
  });

  it("still calls a lead with a website and no attempt 'not checked'", () => {
    const meta = friendlyEmailStatus("not_enriched", true);

    expect(meta.label).toBe("Not checked");
    // Real outstanding work: this is what blocks completion.
    expect(meta.pending).toBe(true);
  });

  it("treats a queued website-less lead as terminal too", () => {
    expect(friendlyEmailStatus("queued", false).label).toBe("No website");
    expect(friendlyEmailStatus("queued", false).pending).toBe(false);
  });

  it.each([
    ["found", "Email found"],
    ["verified", "Email found"],
    ["unverified", "Email found"],
    ["not_found", "No public email"],
    ["failed", "Could not check"],
  ])("reports %s as %s, and as terminal", (status, label) => {
    for (const hasWebsite of [true, false]) {
      const meta = friendlyEmailStatus(status, hasWebsite);
      expect(meta.label).toBe(label);
      // found / not_found / failed are ALL terminal -- none of them is work
      // still to do.
      expect(meta.pending).toBe(false);
    }
  });

  it("defaults to assuming a website when none is stated", () => {
    expect(friendlyEmailStatus("not_enriched").label).toBe("Not checked");
  });
});

describe("isEnrichmentPending", () => {
  it("is true only for a lead that has a website and has not been looked at", () => {
    expect(isEnrichmentPending("not_enriched", true)).toBe(true);

    expect(isEnrichmentPending("not_enriched", false)).toBe(false);
    expect(isEnrichmentPending("found", true)).toBe(false);
    expect(isEnrichmentPending("not_found", true)).toBe(false);
    expect(isEnrichmentPending("failed", true)).toBe(false);
  });

  /**
   * The arithmetic that broke: every lead falls into exactly one bucket, and
   * the buckets sum to the total.
   */
  it("partitions a realistic run with nothing left over", () => {
    const leads = [
      ...Array.from({ length: 204 }, () => ({ status: "found", site: true })),
      ...Array.from({ length: 111 }, () => ({ status: "not_found", site: true })),
      ...Array.from({ length: 77 }, () => ({ status: "failed", site: true })),
      ...Array.from({ length: 93 }, () => ({ status: "not_enriched", site: false })),
    ];

    const pending = leads.filter((l) => isEnrichmentPending(l.status, l.site));
    const noWebsite = leads.filter((l) => !l.site);

    expect(leads).toHaveLength(485);
    expect(noWebsite).toHaveLength(93);
    // NOTHING outstanding: the run really had finished.
    expect(pending).toHaveLength(0);
  });
});

describe("matchesEmailFilter", () => {
  const withEmail = { email: "a@b.co", emailStatus: "found", website: "https://b.co" };
  const noPublic = { email: null, emailStatus: "not_found", website: "https://b.co" };
  const blocked = { email: null, emailStatus: "failed", website: "https://b.co" };
  const pending = { email: null, emailStatus: "not_enriched", website: "https://b.co" };
  const noSite = { email: null, emailStatus: "not_enriched", website: null };

  it("offers a No website group of its own", () => {
    expect(EMAIL_FILTERS.map((f) => f.id)).toContain("no-website");
    expect(matchesEmailFilter("no-website", noSite)).toBe(true);
    expect(matchesEmailFilter("no-website", pending)).toBe(false);
  });

  it("keeps 'Not checked' to leads genuinely awaiting a look", () => {
    expect(matchesEmailFilter("unchecked", pending)).toBe(true);
    // The bug: a website-less lead used to land here and read as outstanding.
    expect(matchesEmailFilter("unchecked", noSite)).toBe(false);
  });

  it("groups the other outcomes as expected", () => {
    expect(matchesEmailFilter("with-email", withEmail)).toBe(true);
    expect(matchesEmailFilter("with-email", pending)).toBe(false);

    expect(matchesEmailFilter("no-email", noPublic)).toBe(true);
    expect(matchesEmailFilter("no-email", blocked)).toBe(true);
    expect(matchesEmailFilter("no-email", noSite)).toBe(false);
  });

  it("lets every lead through the All filter", () => {
    for (const lead of [withEmail, noPublic, blocked, pending, noSite]) {
      expect(matchesEmailFilter("all", lead)).toBe(true);
    }
  });
});
