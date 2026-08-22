import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ProcessingView } from "@/components/generate/processing-view";
import { getCurrentUser } from "@/server/db/server-client";
import { GenerationNotFoundError, loadGenerationState } from "@/server/generate/state";

export const metadata: Metadata = { title: "Generating leads" };

/**
 * Read from the database on every request, so opening this page on a different
 * device -- or after closing the tab -- shows the run exactly where it is.
 */
export const dynamic = "force-dynamic";

export default async function GenerationProcessingPage(props: PageProps<"/generate/[id]">) {
  const { id } = await props.params;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let state;
  try {
    state = await loadGenerationState({ runId: id, userId: user.id });
  } catch (error) {
    if (error instanceof GenerationNotFoundError) notFound();
    throw error;
  }

  // A finished run has a results page; there is nothing to process.
  if (state.status !== "running") {
    redirect(`/generate/${id}/results`);
  }

  return <ProcessingView initialState={state} />;
}
