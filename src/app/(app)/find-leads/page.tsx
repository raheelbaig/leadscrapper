import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/layout/page-header";
import { SearchForm } from "@/components/search/search-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export const metadata: Metadata = { title: "Manual Search" };

/**
 * The manual path, kept intact.
 *
 * This page builds a search and leaves it for you to run tick by tick, with the
 * raw grid controls and an explicit rectangle. It is no longer the normal way
 * to get leads -- Generate Leads does the whole journey -- but nothing here was
 * removed, because a search that needs a hand-drawn rectangle or a non-default
 * grid still needs somewhere to be built.
 */
export default function FindLeadsPage() {
  return (
    <>
      <PageHeader
        title="Manual search"
        description="Every search covers the whole city by construction: the area is tiled, saturated tiles are split into four, and no tile is ever silently skipped."
      />

      <Alert className="max-w-3xl">
        <AlertTitle>Looking for the quick way?</AlertTitle>
        <AlertDescription>
          <Link href="/generate" className="underline">
            Generate Leads
          </Link>{" "}
          asks for a niche and an area and then handles the search, the duplicate removal, the email
          lookup and the Excel file for you. This page is for building a search by hand and running
          it yourself, one tick at a time.
        </AlertDescription>
      </Alert>

      <div className="max-w-3xl">
        <SearchForm />
      </div>
    </>
  );
}
