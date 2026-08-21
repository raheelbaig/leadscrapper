"use client";

import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { EmptyState } from "@/components/common/empty-state";
import { formatDateTime } from "@/lib/format";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * The live activity log.
 *
 * Rows are server-rendered first and then kept current over Realtime. The
 * browser is a VIEWER here, never a worker: it subscribes, it renders, and it
 * refreshes the server component when the search row changes. Closing the tab
 * stops nothing, and opening it starts nothing.
 *
 * Nothing is computed client-side — every value shown has already been written
 * to Postgres by the server, which is what makes it survive a refresh.
 */

export type SearchEventRow = {
  id: number;
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  created_at: string;
};

const LEVEL_META = {
  info: { icon: Info, className: "text-muted-foreground" },
  warn: { icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
  error: { icon: CircleAlert, className: "text-red-600 dark:text-red-400" },
} as const;

export function SearchLiveFeed({
  searchId,
  initialEvents,
}: {
  searchId: string;
  initialEvents: SearchEventRow[];
}) {
  const [events, setEvents] = useState<SearchEventRow[]>(initialEvents);
  const router = useRouter();

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    const channel = supabase
      .channel(`search:${searchId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "search_events",
          filter: `search_id=eq.${searchId}`,
        },
        (payload) => {
          setEvents((current) => [payload.new as SearchEventRow, ...current].slice(0, 100));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "searches",
          filter: `id=eq.${searchId}`,
        },
        () => {
          // The progress figures are server-rendered from the database, so the
          // honest way to update them is to re-render, not to patch a local copy.
          router.refresh();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [searchId, router]);

  if (events.length === 0) {
    return (
      <EmptyState
        title="No events yet"
        description="The activity log starts when the search runs. Every Google request, every tile transition and every refusal is recorded here."
      />
    );
  }

  return (
    <ul className="divide-border divide-y text-sm">
      {events.map((event) => {
        const meta = LEVEL_META[event.level] ?? LEVEL_META.info;
        const Icon = meta.icon;

        return (
          <li key={event.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
            <Icon className={cn("mt-0.5 size-4 shrink-0", meta.className)} />
            <div className="min-w-0 flex-1">
              <p className="break-words">{event.message}</p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">
                {event.code} · {formatDateTime(event.created_at)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
