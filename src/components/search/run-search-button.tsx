"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { PreflightBlockedBanner } from "@/components/search/preflight-panel";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";

/**
 * The manual trigger for one bounded tick.
 *
 * Phase 3A has no cron-driven worker: `private.worker_config.enabled` is false
 * and nothing in the application turns it on. A search runs because a person
 * pressed this button, and it runs exactly once per press — one tile, one page,
 * one billable Google request.
 *
 * The button disables itself while a tick is in flight. That is a courtesy, not
 * the safety mechanism: the real guard against two concurrent runs is the
 * database lease taken by `claim_search_job_by_id`, which a second request
 * simply would not get.
 */

type BlockPayload = { code: string; title: string; message: string; action: string };

type RunResult = {
  outcome: string;
  tileLabel: string | null;
  tileState: string | null;
  searchStatus: string;
  apiCalls: number;
  resultsReceived: number;
  leadsInserted: number;
  duplicatesRejected: number;
  nextPageTokenPresent: boolean;
};

export function RunSearchButton({
  searchId,
  status,
}: {
  searchId: string;
  status: string;
}) {
  const [running, setRunning] = useState(false);
  const [blocked, setBlocked] = useState<BlockPayload | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const alreadyFinished = status === "completed" || status === "canceled";

  async function run() {
    setRunning(true);
    setBlocked(null);

    try {
      const response = await fetch(`/api/searches/${searchId}/run`, { method: "POST" });
      const payload = await response.json();

      if (response.status === 409) {
        // A refusal, not a failure: the run was never allowed to start and no
        // Google request was made.
        setBlocked(payload.blocked as BlockPayload);
        toast.error(payload.blocked?.title ?? "Blocked", {
          description: payload.blocked?.message,
        });
        return;
      }

      if (!response.ok) {
        toast.error("The run could not start", { description: payload.error });
        return;
      }

      const result = payload as RunResult;

      toast.success(`${result.tileLabel ?? "Tile"} · ${result.tileState}`, {
        description:
          `${formatNumber(result.resultsReceived)} result(s) · ` +
          `${formatNumber(result.leadsInserted)} new lead(s) · ` +
          `${formatNumber(result.apiCalls)} API call(s)` +
          (result.duplicatesRejected > 0
            ? ` · ${formatNumber(result.duplicatesRejected)} duplicate(s) rejected`
            : ""),
      });

      // Every figure on this page comes from the database, so a refresh is what
      // makes them current -- nothing important lives in React state.
      await queryClient.invalidateQueries({ queryKey: ["usage"] });
      await queryClient.invalidateQueries({ queryKey: ["searches", "preflight"] });
      router.refresh();
    } catch (error) {
      toast.error("The run could not start", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      {blocked ? <PreflightBlockedBanner block={blocked} /> : null}

      <Button onClick={run} disabled={running || alreadyFinished} size="lg" className="gap-2">
        {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {running ? "Running one tile…" : alreadyFinished ? "Finished" : "Run one tile"}
      </Button>

      <p className="text-muted-foreground text-xs">
        One tile, one page, one billable request. Pagination and subdivision arrive in Phase 3B.
      </p>
    </div>
  );
}
