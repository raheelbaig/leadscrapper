import {
  Download,
  Gauge,
  LayoutDashboard,
  Mail,
  MapPinned,
  Search,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";

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
 * Navigation, ordered by how often a normal day needs it.
 *
 * The normal path is Generate Leads -> the processing screen -> the results
 * page, and none of the steps in between are navigation the user has to
 * perform. Everything under "Advanced" still works and is still linked to from
 * the results page; those pages became history and detail views rather than
 * stops on the way to a lead list.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        hint: "Everything at a glance",
      },
      {
        href: "/generate",
        label: "Generate Leads",
        icon: Sparkles,
        hint: "Niche, area, and one button",
      },
      { href: "/leads", label: "Leads", icon: Users, hint: "Every business you have found" },
    ],
  },
  {
    label: "Advanced",
    items: [
      {
        href: "/searches",
        label: "Search History",
        icon: Search,
        hint: "Coverage maps, sections and activity logs",
      },
      { href: "/exports", label: "Exports", icon: Download, hint: "Every workbook you generated" },
      { href: "/enrichment", label: "Enrichment", icon: Mail, hint: "Email discovery status" },
      { href: "/usage", label: "API Usage", icon: Gauge, hint: "Free quota and spend protection" },
      {
        href: "/settings",
        label: "Settings",
        icon: Settings,
        hint: "Grid defaults and saved areas",
      },
      {
        href: "/find-leads",
        label: "Manual Search",
        icon: MapPinned,
        hint: "Build a search by hand, run it tick by tick",
      },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
