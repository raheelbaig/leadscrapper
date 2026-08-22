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
 * One press works through pending tiles until a budget stops it: the tile cap,
 * the per-tick call cap, the per-SEARCH call budget, or the wall-clock slice.
 * Whichever binds first wins, and the run pauses with the remaining geography
 * still owed and visible.
 *
 * IT DOES NOT STOP AT THE LEAD TARGET. The target is a minimum desired
 * benchmark; a search finishes when the area is covered. A press that finds
 * more leads than the target asked for keeps going.
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
  targetReached: boolean;
  coverage: { tilesRemaining: number; summary: string; fullyCovered: boolean };
};

/**
 * Plain-English endings, so a pause never looks like a failure.
 *
 * Note what is NOT here: an ending that says the lead target stopped the run.
 * `stopped_at_target` exists only for searches created before the target became
 * a benchmark, and its wording says plainly that geography is still owed.
 */
const STOP_REASON_TEXT: Record<string, string> = {
  coverage_complete: "Every tile has been searched. This search is complete.",
  tile_budget_reached: "The tick reached its tile limit. Press Run again to continue.",
  call_budget_reached: "This search has spent its call budget.",
  tick_slice_expired: "The run reached its time slice. Press Run again to continue.",
  quota_exhausted: "The protected free allowance is spent.",
  tile_error: "A tile failed. It returns to pending and retries on the next press.",
  fatal_api_error: "Google rejected the request in a way that will not fix itself.",
  lease_lost: "Another runner took over this search.",
  paused_by_user: "Paused. The remaining tiles are still owed.",
  canceled: "Canceled. The remaining tiles were not searched.",
  stopped_at_target:
    "This search was created with the old policy and stopped at its lead target — " +
    "the remaining area was NOT searched. Use “Continue to full coverage” to finish it.",
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
      const tilesDone = result.tiles.length;

      const headline =
        tilesDone === 0
          ? "Nothing left to do"
          : `${formatNumber(tilesDone)} tile(s) searched · ${formatNumber(result.leadsInserted)} new lead(s)`;

      const detail =
        (tilesDone > 0
          ? `${formatNumber(result.resultsReceived)} result(s)` +
            (result.duplicatesRejected > 0
              ? ` · ${formatNumber(result.duplicatesRejected)} duplicate(s) rejected`
              : "") +
            ` · ${formatNumber(result.apiCalls)} API call(s)`
          : "") + `\n${STOP_REASON_TEXT[result.stopReason] ?? result.stopReason}`;

      const notify = result.outcome === "failed" ? toast.error : toast.success;
      notify(headline, { description: detail });

      // Exceeding the target is a RESULT, reported on its own. It is never
      // presented as the reason a run ended, because it is not one.
      if (result.targetReached && result.leadsFound > result.targetLeads) {
        toast.info(
          `${formatNumber(result.leadsFound)} leads — past the ${formatNumber(result.targetLeads)} you asked for`,
          {
            description:
              "The target is a minimum. The search keeps going until the area is covered.",
          },
        );
      }

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
          ? "Searching…"
          : alreadyFinished
            ? status === "completed"
              ? "Complete"
              : "Canceled"
            : outOfBudget
              ? "Call budget spent"
              : nothingLeft
                ? "No tiles left"
                : "Run"}
      </Button>

      <p className="text-muted-foreground text-xs">
        Each press works through pending tiles until a budget or the time slice stops it. Up to 3
        pages per tile, each page separately reserved against the free allowance.{" "}
        {formatNumber(tilesRemaining)} tile(s) still owed · {formatNumber(budgetRemaining)} call(s)
        left in this search&rsquo;s budget.
      </p>
    </div>
  );
}
