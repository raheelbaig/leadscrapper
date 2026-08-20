import {
  Download,
  Gauge,
  LayoutDashboard,
  Mail,
  MapPinned,
  Search,
  Settings,
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
    ],
  },
  {
    label: "Find",
    items: [
      {
        href: "/find-leads",
        label: "Find Leads",
        icon: MapPinned,
        hint: "Start a new coverage-first search",
      },
      {
        href: "/searches",
        label: "Searches",
        icon: Search,
        hint: "Running, paused and finished searches",
      },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/leads", label: "Leads", icon: Users, hint: "Every business you have found" },
      { href: "/enrichment", label: "Enrichment", icon: Mail, hint: "Email discovery status" },
      { href: "/exports", label: "Exports", icon: Download, hint: "Generated workbooks" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/usage", label: "API Usage", icon: Gauge, hint: "Free quota and spend protection" },
      { href: "/settings", label: "Settings", icon: Settings, hint: "Grid defaults and areas" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
