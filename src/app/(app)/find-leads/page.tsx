import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/page-header";
import { SearchForm } from "@/components/search/search-form";

export const metadata: Metadata = { title: "Find Leads" };

export default function FindLeadsPage() {
  return (
    <>
      <PageHeader
        title="Find new leads"
        description="Every search covers the whole city by construction: the area is tiled, saturated tiles are split into four, and no tile is ever silently skipped."
      />
      <div className="max-w-3xl">
        <SearchForm />
      </div>
    </>
  );
}
