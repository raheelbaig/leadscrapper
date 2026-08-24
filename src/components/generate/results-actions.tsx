"use client";

import { Download, Loader2, Mail, RotateCcw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { downloadExport } from "@/lib/generate/download-export";
import { formatNumber, formatPercent } from "@/lib/format";

/**
 * Everything the user might want to do next, on the page they are already on.
 *
 * Exporting does not send them to Exports, continuing does not send them to
 * Searches, and retrying an email does not send them to Enrichment. Those pages
 * still exist and still work -- they are history and power-user views now, not
 * stops on the normal path.
 */

export function ExportExcelButton({
  searchId,
  leadCount,
}: {
  searchId: string;
  leadCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [exportId, setExportId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
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

      setExportId(payload.exportId);
      toast.success("Excel file is ready.", {
        description: payload.partialCoverage
          ? `${formatNumber(payload.rowCount)} leads. Only ${formatPercent(payload.coveragePct, 1)} of the area was searched — the Coverage sheet inside the file names every section that was not.`
          : `${formatNumber(payload.rowCount)} leads. The whole area was searched.`,
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

  async function startDownload(id: string) {
    setDownloading(true);
    try {
      const outcome = await downloadExport(id);

      // SUCCESS MEANS THE FILE ARRIVED, not that a link was minted. The old
      // code announced success as soon as the export row existed, which is how
      // a toast came to appear over a download that never happened.
      if (!outcome.ok) {
        toast.error("The download did not complete", { description: outcome.error });
        return;
      }

      toast.success("Excel downloaded successfully.", {
        description: `${outcome.filename} · ${formatNumber(Math.round(outcome.bytes / 1024))} KB`,
      });
    } finally {
      setDownloading(false);
    }
  }

  if (exportId) {
    return (
      <Button
        size="lg"
        className="gap-2"
        onClick={() => startDownload(exportId)}
        disabled={downloading}
      >
        {downloading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
        {downloading ? "Downloading…" : "Download Excel"}
      </Button>
    );
  }

  return (
    <Button size="lg" className="gap-2" onClick={generate} disabled={busy || leadCount === 0}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      {busy ? "Building…" : leadCount === 0 ? "Nothing to export" : "Export Excel"}
    </Button>
  );
}

/**
 * A NEW approval over the same search.
 *
 * Used both for unsearched area and for email discovery that was never
 * consented to. Either way it creates a fresh generation run with a fresh
 * ceiling and drops the user back on the processing screen -- the previous
 * approval is not reopened or widened.
 */
export function ContinueGenerationButton({
  searchId,
  label,
  areasRemaining,
  enrichEmails = true,
  variant = "outline",
  icon = "search",
}: {
  searchId: string;
  label: string;
  areasRemaining?: number;
  enrichEmails?: boolean;
  variant?: "default" | "outline";
  icon?: "search" | "mail";
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function start() {
    setBusy(true);
    try {
      const response = await fetch("/api/generate/continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchId, enrichEmails }),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("Could not continue", { description: payload.error });
        return;
      }

      router.push(`/generate/${payload.runId}`);
    } catch (error) {
      toast.error("Could not continue", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const Icon = icon === "mail" ? Mail : Search;

  return (
    <Button variant={variant} size="lg" className="gap-2" onClick={start} disabled={busy}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      {label}
      {typeof areasRemaining === "number" && areasRemaining > 0 ? (
        <span className="text-muted-foreground text-xs">({formatNumber(areasRemaining)} left)</span>
      ) : null}
    </Button>
  );
}

/**
 * Retries the leads whose last look failed.
 *
 * Explicit by design, and bounded: `retry-failed` can only reach a lead whose
 * last attempt failed, never one that already has an address, and a lead that
 * has been tried its maximum number of times is dropped from selection -- so
 * pressing this repeatedly terminates.
 */
export function RetryFailedEmailsButton({
  searchId,
  failedCount,
}: {
  searchId: string;
  failedCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function retry() {
    setBusy(true);
    try {
      const response = await fetch("/api/enrichment/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "retry-failed", searchId, dryRun: false }),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("The retry could not run", { description: payload.error });
        return;
      }

      toast.success(`Checked ${formatNumber(payload.processed)} business website(s) again`, {
        description:
          `${formatNumber(payload.found)} email(s) found · ` +
          `${formatNumber(payload.notFound)} with no address · ` +
          `${formatNumber(payload.failed)} still unreachable.`,
      });
      router.refresh();
    } catch (error) {
      toast.error("The retry could not run", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="lg"
      className="gap-2"
      onClick={retry}
      disabled={busy || failedCount === 0}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
      Retry failed emails
      {failedCount > 0 ? (
        <span className="text-muted-foreground text-xs">({formatNumber(failedCount)})</span>
      ) : null}
    </Button>
  );
}
