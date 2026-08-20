import { NextResponse } from "next/server";

import { resolveLocationSchema } from "@/lib/schemas/location";
import { getCurrentUser, getSupabaseServerClient } from "@/server/db/server-client";
import { BboxResolutionError, resolveBbox } from "@/server/geo/bbox-resolver";
import { EXTERNAL_PROVIDERS_ENABLED } from "@/server/geo/resolver-config";
import { ProviderNotEnabledError } from "@/server/geo/types";

/**
 * POST /api/locations/resolve
 *
 * Resolves a country/state/city to a bounding box through the provider chain.
 *
 * PHASE 2: MOCK PROVIDERS ONLY. `EXTERNAL_PROVIDERS_ENABLED` is false, so the
 * Geocoding and Places-viewport providers are skipped without being invoked and
 * the fixture provider answers instead. The response says so explicitly --
 * `mockMode: true` and `externalCallsMade: 0` -- rather than presenting an
 * approximation as a resolved boundary.
 *
 * The cache and custom-area providers are real and run under the request client,
 * so a location already in `locations` still wins, exactly as it will in Phase 3.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = resolveLocationSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid location request.",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const db = await getSupabaseServerClient();

  try {
    const result = await resolveBbox(
      {
        country: parsed.data.country,
        state: parsed.data.state ?? null,
        city: parsed.data.city,
        customAreaId: parsed.data.customAreaId ?? null,
        manualBbox: parsed.data.manualBbox ?? null,
        userId: user.id,
      },
      { db },
    );

    return NextResponse.json(
      {
        location: result.location,
        attempts: result.attempts,
        externalCallsMade: result.externalCallsMade,
        persisted: result.persisted,
        mockMode: !EXTERNAL_PROVIDERS_ENABLED,
      },
      { headers: { "cache-control": "no-store, max-age=0" } },
    );
  } catch (error) {
    if (error instanceof BboxResolutionError) {
      return NextResponse.json(
        { error: error.message, attempts: error.attempts, mockMode: !EXTERNAL_PROVIDERS_ENABLED },
        { status: 422 },
      );
    }
    if (error instanceof ProviderNotEnabledError) {
      return NextResponse.json({ error: error.message }, { status: 501 });
    }

    console.error("POST /api/locations/resolve failed", error);
    return NextResponse.json({ error: "Could not resolve that location." }, { status: 500 });
  }
}
