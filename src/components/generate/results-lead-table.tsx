"use client";

import { ArrowUpDown, Check, Copy, ExternalLink, MapPin, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { EmailStatusBadge } from "@/components/leads/email-status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The results table.
 *
 * Everything the user came for, on the page they land on: no navigating to
 * Leads, no opening a search, no exporting just to read an address. Filtering
 * and sorting happen in the browser over rows the server already sent, so they
 * cost nothing and touch nothing.
 */

export type ResultLead = {
  id: string;
  name: string;
  phone: string | null;
  website: string | null;
  mapsUrl: string | null;
  email: string | null;
  emailStatus: string;
  emailConfidence: number | null;
  city: string | null;
  state: string | null;
};

type SortKey = "name" | "email" | "city";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "with-email", label: "With email" },
  { id: "with-website", label: "With website" },
  { id: "no-email", label: "No email yet" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export function ResultsLeadTable({ leads }: { leads: ResultLead[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [ascending, setAscending] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const matches = leads.filter((lead) => {
      if (filter === "with-email" && !lead.email) return false;
      if (filter === "with-website" && !lead.website) return false;
      if (filter === "no-email" && lead.email) return false;

      if (!needle) return true;
      return [lead.name, lead.email, lead.city, lead.state, lead.website, lead.phone]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });

    const direction = ascending ? 1 : -1;
    return [...matches].sort((a, b) => {
      const left = (sortKey === "name" ? a.name : sortKey === "email" ? a.email : a.city) ?? "";
      const right = (sortKey === "name" ? b.name : sortKey === "email" ? b.email : b.city) ?? "";
      // Empty values sort last regardless of direction: a blank email column is
      // never the most interesting thing on the page.
      if (left === "" && right !== "") return 1;
      if (right === "" && left !== "") return -1;
      return left.localeCompare(right) * direction;
    });
  }, [leads, query, filter, sortKey, ascending]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((value) => !value);
      return;
    }
    setSortKey(key);
    setAscending(true);
  }

  async function copyEmail(lead: ResultLead) {
    if (!lead.email) return;
    try {
      await navigator.clipboard.writeText(lead.email);
      setCopied(lead.id);
      setTimeout(() => setCopied((value) => (value === lead.id ? null : value)), 1_500);
    } catch {
      toast.error("Could not copy that address");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search businesses, emails, cities…"
            className="pl-8"
            aria-label="Search leads"
          />
        </div>

        <div className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={filter === option.id ? "secondary" : "ghost"}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        Showing {visible.length} of {leads.length} leads
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead
                label="Business"
                active={sortKey === "name"}
                onClick={() => toggleSort("name")}
              />
              <TableHead>Phone</TableHead>
              <TableHead>Website</TableHead>
              <SortableHead
                label="Email"
                active={sortKey === "email"}
                onClick={() => toggleSort("email")}
              />
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
              <SortableHead
                label="City"
                active={sortKey === "city"}
                onClick={() => toggleSort("city")}
              />
              <TableHead>State</TableHead>
              <TableHead className="w-[6rem]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((lead) => (
              <TableRow key={lead.id}>
                <TableCell className="font-medium">{lead.name}</TableCell>
                <TableCell className="tabular-nums">{lead.phone ?? "—"}</TableCell>
                <TableCell className="max-w-[12rem] truncate text-xs">
                  {lead.website ? (
                    <a
                      href={lead.website}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {lead.website.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {lead.email ? (
                    <a href={`mailto:${lead.email}`} className="hover:underline">
                      {lead.email}
                    </a>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <EmailStatusBadge status={lead.emailStatus} />
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                  {lead.emailConfidence === null
                    ? "—"
                    : `${Math.round(lead.emailConfidence * 100)}%`}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">{lead.city ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{lead.state ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-0.5">
                    {lead.email ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => copyEmail(lead)}
                        aria-label={`Copy the email address for ${lead.name}`}
                      >
                        {copied === lead.id ? (
                          <Check className="size-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </Button>
                    ) : null}
                    {lead.website ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        render={<a href={lead.website} target="_blank" rel="noreferrer" />}
                        aria-label={`Open the website for ${lead.name}`}
                      >
                        <ExternalLink className="size-3.5" />
                      </Button>
                    ) : null}
                    {lead.mapsUrl ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        render={<a href={lead.mapsUrl} target="_blank" rel="noreferrer" />}
                        aria-label={`Open ${lead.name} on Google Maps`}
                      >
                        <MapPin className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {visible.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          No leads match that filter.
        </p>
      ) : null}
    </div>
  );
}

function SortableHead({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <TableHead>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "hover:text-foreground flex items-center gap-1",
          active && "text-foreground font-medium",
        )}
      >
        {label}
        <ArrowUpDown className="size-3" />
      </button>
    </TableHead>
  );
}
