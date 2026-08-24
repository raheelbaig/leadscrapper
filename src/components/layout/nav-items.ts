import { LayoutDashboard, Search, Sparkles, Users } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Shown as a muted hint under the label in the mobile sheet. */
  hint?: string;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

/**
 * Three destinations. That is the whole product.
 *
 * WHAT IS DELIBERATELY ABSENT, and where it went:
 *
 *   Enrichment  -- email discovery is automatic now. A page for running it by
 *                  hand is a page for doing the orchestrator's job, and its
 *                  operator-level detail (providers, attempts, batches,
 *                  robots.txt) is not something a user should have to learn.
 *   API Usage   -- the numbers still matter, so they moved to where the
 *                  spending happens: the generate form, the processing screen
 *                  and the results page all show requests used against the
 *                  limit. A dedicated page made a routine figure feel like an
 *                  admin console.
 *   Exports     -- the workbook button now sits directly above the leads it
 *                  exports. Sending someone to another page to collect a file
 *                  they just asked for is a step with no purpose.
 *   Manual Search / Settings -- building a search by hand and editing grid
 *                  defaults are power-user tools, not steps in getting leads.
 *
 * NONE OF THOSE ROUTES WERE DELETED, and no service behind them changed. They
 * are reachable by URL and still work; they are simply not decisions a
 * first-time user is asked to make. Search history stays in the primary nav
 * because looking up what you found last week is a normal thing to want.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/generate",
        label: "Generate Leads",
        icon: Sparkles,
        hint: "Niche, area, and one button",
      },
      {
        href: "/searches",
        label: "Active Searches",
        icon: Search,
        hint: "Everything you have run, past and present",
      },
      { href: "/leads", label: "Leads", icon: Users, hint: "Every business you have found" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
