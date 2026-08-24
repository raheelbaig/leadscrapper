"use client";

import { Download, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { downloadExport } from "@/lib/generate/download-export";
import { formatNumber, formatPercent } from "@/lib/format";

/**
 * Generates a workbook for one search.
 *
 * Exporting costs nothing — it reads rows that were already paid for and makes
 * no Google request. What it can do is produce a misleading artifact, so the
 * toast repeats what the Coverage worksheet says: if the area was not fully
 * searched, that is stated at the moment of export rather than left to be
 * discovered inside the file.
 */
export function ExportSearchButton({
  searchId,
  leadCount,
  size = "default",
}: {
  searchId: string;
  leadCount: number;
  size?: "default" | "sm" | "lg";
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function generate() {
    setBusy(true);
    try {
      const response = await fetch("/api/exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchId }),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("The export could not be generated", { description: payload.error });
        return;
      }

      toast.success(`Workbook ready — ${formatNumber(payload.rowCount)} lead(s)`, {
        description: payload.partialCoverage
          ? `Coverage was ${formatPercent(payload.coveragePct, 1)}. The Coverage worksheet names every unsearched tile.`
          : "The whole requested area was searched. The Coverage worksheet records the invariant check.",
        action: {
          label: "Download",
          onClick: () => {
            void triggerDownload(payload.exportId);
          },
        },
      });

      router.refresh();
    } catch (error) {
      toast.error("The export could not be generated", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      onClick={generate}
      disabled={busy || leadCount === 0}
      variant="outline"
      size={size}
      className="gap-2"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      {busy ? "Building…" : leadCount === 0 ? "Nothing to export" : "Export to Excel"}
    </Button>
  );
}

/**
 * Fetches the workbook and hands it to the browser.
 *
 * Shared with the results page through `downloadExport`, so the advanced
 * Exports view and the normal flow cannot drift apart -- and so neither can
 * report success for a download that did not happen.
 */
async function triggerDownload(exportId: string): Promise<void> {
  const outcome = await downloadExport(exportId);
  if (!outcome.ok) {
    toast.error("The download did not complete", { description: outcome.error });
    return;
  }
  toast.success("Excel downloaded successfully.", { description: outcome.filename });
}

/** Re-download for an already-generated workbook. */
export function DownloadExportButton({ exportId, label }: { exportId: string; label: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await triggerDownload(exportId);
        } finally {
          setBusy(false);
        }
      }}
      aria-label={`Download ${label}`}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      {busy ? "Downloading…" : "Download"}
    </Button>
  );
}
