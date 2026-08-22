import type { Metadata } from "next";

import { GenerateForm } from "@/components/generate/generate-form";
import { PageHeader } from "@/components/layout/page-header";
import { areaOptionId, type GenerateArea } from "@/lib/generate/areas";
import { getSupabaseServerClient } from "@/server/db/server-client";
import { CITY_FIXTURES } from "@/server/geo/fixtures/cities";
import { GENERATION_LIMITS } from "@/server/generate/limits";
import { runPreflight } from "@/server/search/preflight";

export const metadata: Metadata = { title: "Generate Leads" };

/** Every figure is read from the database on each request, so a refresh is truth. */
export const dynamic = "force-dynamic";

/**
 * The start of the normal path.
 *
 * The areas offered are assembled HERE, on the server, rather than being typed
 * by the user: while external boundary lookups are switched off, a rectangle
 * can only come from a shipped fixture, from an area the user saved, or from
 * one they draw by hand. Offering a free-text city box would accept anything
 * and fail after the form was filled in.
 *
 * Nothing on this page costs anything. The quota figures are read from the
 * counter in Postgres -- asking Google how much Google quota is left would
 * itself be a billable request.
 */
export default async function GeneratePage() {
  const supabase = await getSupabaseServerClient();

  const [{ data: customAreas }, preflight] = await Promise.all([
    supabase
      .from("custom_areas")
      .select("id, name, country, state, city, min_lat, min_lng, max_lat, max_lng")
      .order("name"),
    runPreflight({ callBudget: GENERATION_LIMITS.maxGoogleCallsPerRun }),
  ]);

  const fixtureAreas: GenerateArea[] = CITY_FIXTURES.map((fixture) => ({
    id: areaOptionId({
      kind: "fixture",
      country: fixture.country,
      state: fixture.state,
      city: fixture.city,
    }),
    kind: "fixture",
    name: fixture.city,
    country: fixture.country,
    state: fixture.state,
    city: fixture.city,
    customAreaId: null,
    bbox: fixture.bbox,
  }));

  const savedAreas: GenerateArea[] = (customAreas ?? []).map((area) => ({
    id: areaOptionId({
      kind: "custom",
      country: area.country,
      state: area.state,
      city: area.city ?? area.name,
      customAreaId: area.id,
    }),
    kind: "custom",
    name: area.name,
    country: area.country,
    state: area.state,
    // A saved area may span several municipalities and have no city of its own.
    city: area.city ?? area.name,
    customAreaId: area.id,
    bbox: {
      minLat: area.min_lat,
      minLng: area.min_lng,
      maxLat: area.max_lat,
      maxLng: area.max_lng,
    },
  }));

  return (
    <>
      <PageHeader
        title="Generate leads"
        description="Tell us what businesses you need and where. We search the whole area, remove duplicates, look for contact emails, and get your Excel file ready."
      />
      <div className="max-w-3xl">
        <GenerateForm
          areas={[...fixtureAreas, ...savedAreas]}
          quota={{
            used: preflight.quota.used,
            freeLimit: preflight.quota.freeLimit,
            remaining: preflight.quota.remaining,
          }}
          callCeiling={GENERATION_LIMITS.maxGoogleCallsPerRun}
        />
      </div>
    </>
  );
}
