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
 * Phase 3B has no cron-driven worker: `private.worker_config.enabled` is false
 * and nothing in the application turns it on. A search runs because a person
 * pressed this button, and one press processes ONE tile — up to three pages,
 * each with its own quota reservation.
 *
 * One tile per press is deliberate. It makes resume trivially auditable: press,
 * read the tile row, press again. It also means the geography left unsearched
 * is visible between presses rather than only at the end.
 *
 * The button disables itself while a tick is in flight. That is a courtesy, not
 * the safety mechanism: the real guard against two concurrent runs is the
 * database lease taken by `claim_search_job_by_id`, which a second request
 * simply would not get.
 */

type BlockPayload = { code: string; title: string; message: string; action: string };

type TileSummary = {
  tileLabel: string;
  state: string;
  pagesFetched: number;
  resultsReceived: number;
  leadsInserted: number;
  duplicatesRejected: number;
  childrenCreated: number;
};

type RunResult = {
  outcome: string;
  stopReason: string;
  tiles: TileSummary[];
  apiCalls: number;
  apiCallsTotal: number;
  callBudget: number;
  resultsReceived: number;
  leadsInserted: number;
  duplicatesRejected: number;
  leadsFound: number;
  targetLeads: number;
  coverage: { tilesRemaining: number; summary: string; fullyCovered: boolean };
};

/** Plain-English endings, so a pause never looks like a failure. */
const STOP_REASON_TEXT: Record<string, string> = {
  coverage_complete: "Every tile has been searched.",
  target_reached: "The lead target was reached — remaining tiles were not searched.",
  tile_budget_reached: "One tile per press. Press Run again to continue.",
  call_budget_reached: "This search has spent its call budget.",
  tick_slice_expired: "The run reached its time slice. Press Run again to continue.",
  quota_exhausted: "The protected free allowance is spent.",
  tile_error: "A tile failed. It returns to pending and retries on the next press.",
  fatal_api_error: "Google rejected the request in a way that will not fix itself.",
  lease_lost: "Another runner took over this search.",
};

export function RunSearchButton({
  searchId,
  status,
  tilesRemaining,
  budgetRemaining,
}: {
  searchId: string;
  status: string;
  tilesRemaining: number;
  budgetRemaining: number;
}) {
  const [running, setRunning] = useState(false);
  const [blocked, setBlocked] = useState<BlockPayload | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const alreadyFinished = status === "completed" || status === "canceled";
  const outOfBudget = budgetRemaining <= 0;
  const nothingLeft = tilesRemaining === 0 && !alreadyFinished;

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
      const tile = result.tiles.at(-1);

      const headline = tile ? `${tile.tileLabel} · ${tile.state}` : "Nothing left to do";
      const detail =
        (tile
          ? `${formatNumber(tile.pagesFetched)} page(s) · ` +
            `${formatNumber(result.resultsReceived)} result(s) · ` +
            `${formatNumber(result.leadsInserted)} new lead(s)` +
            (result.duplicatesRejected > 0
              ? ` · ${formatNumber(result.duplicatesRejected)} duplicate(s) rejected`
              : "") +
            (tile.childrenCreated > 0 ? ` · split into ${tile.childrenCreated} tiles` : "") +
            ` · ${formatNumber(result.apiCalls)} API call(s)`
          : "") + `\n${STOP_REASON_TEXT[result.stopReason] ?? result.stopReason}`;

      const notify = result.outcome === "failed" ? toast.error : toast.success;
      notify(headline, { description: detail });

      if (!result.coverage.fullyCovered && result.coverage.tilesRemaining > 0) {
        toast.warning(`${result.coverage.tilesRemaining} tile(s) still unsearched`, {
          description: result.coverage.summary,
        });
      }

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

      <Button
        onClick={run}
        disabled={running || alreadyFinished || outOfBudget || nothingLeft}
        size="lg"
        className="gap-2"
      >
        {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        {running
          ? "Running one tile…"
          : alreadyFinished
            ? "Finished"
            : outOfBudget
              ? "Call budget spent"
              : nothingLeft
                ? "No tiles left"
                : "Run one tile"}
      </Button>

      <p className="text-muted-foreground text-xs">
        One tile per press, up to 3 pages, each page separately reserved against the free allowance.{" "}
        {formatNumber(tilesRemaining)} tile(s) still owed · {formatNumber(budgetRemaining)} call(s)
        left in this search&rsquo;s budget.
      </p>
    </div>
  );
}
