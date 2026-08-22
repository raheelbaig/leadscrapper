"use client";

import { Download, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
            // A real document request, not a client-side navigation. The route
            // answers 307 to a short-lived signed Storage URL, and letting the
            // Next router "navigate" to it would try to render it as a page.
            triggerDownload(payload.exportId);
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
 * Fetches the workbook as a document rather than navigating to it.
 *
 * The download route replies 307 to a short-lived signed Storage URL. That is a
 * file transfer, not a page, so it must not go through the Next.js router --
 * `router.push` would try to treat the .xlsx as a route and the download would
 * never start. A detached anchor click is the plain-browser primitive for this.
 */
function triggerDownload(exportId: string): void {
  const anchor = document.createElement("a");
  anchor.href = `/api/exports/${exportId}/download`;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Re-download for an already-generated workbook. */
export function DownloadExportButton({ exportId, label }: { exportId: string; label: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5"
      onClick={() => triggerDownload(exportId)}
      aria-label={`Download ${label}`}
    >
      <Download className="size-3.5" />
      Download
    </Button>
  );
}
