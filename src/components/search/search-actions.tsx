"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, Pause, Play, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatNumber } from "@/lib/format";

/**
 * Lifecycle controls for one search.
 *
 * None of these spends anything. Pause and cancel only write a status, and the
 * running tick reads that status between tiles and stops itself -- so pressing
 * Pause never abandons a request mid-flight or strands a worker lease.
 *
 * Resume returns the search to the queue and stops there. Making it runnable
 * and actually running it are two separate acts on purpose: spending is always
 * a deliberate press.
 */

type Action = "pause" | "resume" | "cancel";

export function SearchActionsMenu({
  searchId,
  status,
  leadCount,
  redirectTo,
}: {
  searchId: string;
  status: string;
  leadCount: number;
  /**
   * Where to go after a delete. A string rather than a callback, because the
   * server components that render this cannot pass a function across the
   * boundary. The detail page sends the user back to the list; the list page
   * omits it and simply refreshes.
   */
  redirectTo?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const canPause = status === "queued" || status === "running";
  const canResume = status === "paused" || status === "failed" || status === "draft";
  const canCancel = status !== "completed" && status !== "canceled";
  const canDelete = status !== "running";

  async function act(action: Action) {
    setBusy(true);
    try {
      const response = await fetch(`/api/searches/${searchId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("That did not work", { description: payload.error });
        return;
      }

      toast.success(payload.message);
      await queryClient.invalidateQueries({ queryKey: ["searches"] });
      router.refresh();
    } catch (error) {
      toast.error("That did not work", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const response = await fetch(`/api/searches/${searchId}`, { method: "DELETE" });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("Could not delete the search", { description: payload.error });
        return;
      }

      toast.success(`Deleted “${payload.label}”`, {
        description: `${formatNumber(payload.leadsDeleted)} lead(s) removed. The API usage record is unchanged.`,
      });

      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch (error) {
      toast.error("Could not delete the search", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Search actions" disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MoreHorizontal className="size-4" />
              )}
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={!canPause} onClick={() => act("pause")}>
            <Pause className="size-4" />
            Pause
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canResume} onClick={() => act("resume")}>
            <Play className="size-4" />
            Resume
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canCancel} onClick={() => setConfirmingCancel(true)}>
            <X className="size-4" />
            Cancel search
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canDelete}
            variant="destructive"
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="size-4" />
            Delete permanently
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this search?</AlertDialogTitle>
            <AlertDialogDescription>
              The leads already collected are kept. Any tile that was never searched stays visible
              as a gap in the coverage report rather than being quietly written off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => act("cancel")}>
              Cancel search
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this search permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the search, its {formatNumber(leadCount)} lead(s), its tiles and its
              activity log. It cannot be undone. The record of Google calls already made is kept, so
              this never makes the month&rsquo;s usage look smaller than it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * "Continue to full coverage" — the one amendment a frozen `grid_config` takes.
 *
 * Only rendered for a search created before the lead target stopped being a
 * termination condition. It flips exactly one boolean, keeps the geometry and
 * every collected lead, and records that it happened. Nothing does this
 * automatically: an old search keeps the policy it was created under until this
 * is pressed.
 */
export function ContinueToFullCoverageButton({
  searchId,
  tilesRemaining,
}: {
  searchId: string;
  tilesRemaining: number;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function amend() {
    setBusy(true);
    try {
      const response = await fetch(`/api/searches/${searchId}/stop-policy`, { method: "POST" });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("Could not change the stop policy", { description: payload.error });
        return;
      }

      toast.success("This search now runs to full coverage", { description: payload.message });
      router.refresh();
    } catch (error) {
      toast.error("Could not change the stop policy", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={amend} disabled={busy} variant="secondary" size="lg" className="gap-2">
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
      Continue to full coverage
      {tilesRemaining > 0 ? (
        <span className="text-muted-foreground">· {formatNumber(tilesRemaining)} tile(s) owed</span>
      ) : null}
    </Button>
  );
}
