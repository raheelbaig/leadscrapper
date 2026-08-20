"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { useEffect } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the usage page.
 *
 * The reassurance matters as much as the retry button: failing to READ the
 * counter cannot cause a billable call. The guard that authorises requests is a
 * separate, atomic function in Postgres, and it fails closed.
 */
export default function UsageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Usage page failed to render", error);
  }, [error]);

  return (
    <Alert variant="destructive">
      <AlertTriangle className="size-4" />
      <AlertTitle>Could not load API usage</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          The usage counters could not be read. Nothing has been spent as a result — this page only
          reads, and the budget guard that authorises Google requests is a separate function in the
          database that fails closed.
        </p>
        {error.digest ? (
          <p className="font-mono text-xs opacity-70">Reference: {error.digest}</p>
        ) : null}
        <Button variant="outline" size="sm" onClick={reset}>
          <RotateCw className="size-3.5" />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
