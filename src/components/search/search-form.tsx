"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Info, Loader2, MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { PreflightPanel } from "@/components/search/preflight-panel";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_GRID_CONFIG } from "@/lib/constants";
import { bboxAreaKm2, gridDimensions } from "@/lib/geo/bbox";
import { createSearchSchema, type CreateSearchInput } from "@/lib/schemas/search";

/**
 * A ~254 km2 rectangle over the Houston inner loop: about 15.5 x 16.4 km.
 *
 * The starting value, not a ceiling: the server now admits up to 5,000 km2, so
 * the Houston city bounding box (~3,700 km2, a ~90-tile crawl) is a legitimate
 * search. This box is the default because a small rectangle is the honest place
 * to start when the per-search call budget is 150 -- at the 8 km seed edge it
 * tiles into a 3 x 2 grid whose tiles are large enough that pagination to page
 * 2 is actually exercised rather than theorised.
 */
const HOUSTON_INNER_LOOP_TEST_BOX = {
  minLat: 29.69,
  minLng: -95.45,
  maxLat: 29.83,
  maxLng: -95.28,
} as const;

/**
 * Mirrors SEARCH_LIMITS. The server is authoritative and refuses anything
 * past these on its own; they are repeated here only so the form can warn
 * before a submission that would be rejected.
 */
const MAX_AREA_KM2 = 5_000;
const MAX_SEED_TILES = 400;

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

export function SearchForm() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<CreateSearchInput>({
    resolver: zodResolver(createSearchSchema),
    defaultValues: {
      niche: "",
      country: "United States",
      state: "",
      city: "Houston",
      targetLeads: 40,
      gridConfig: DEFAULT_GRID_CONFIG,
      testBbox: HOUSTON_INNER_LOOP_TEST_BOX,
    },
  });

  const testBbox = useWatch({ control, name: "testBbox" });
  const seedTileEdgeKm = useWatch({ control, name: "gridConfig.seedTileEdgeKm" });

  // Shown live, because the area and the seed edge are the two numbers that
  // decide how many tiles -- and therefore how many billable calls -- a search
  // will cost. Computed with the SAME pure functions the server plans with, so
  // the preview cannot promise a grid the server would build differently.
  const plan = (() => {
    const box = {
      minLat: Number(testBbox?.minLat),
      minLng: Number(testBbox?.minLng),
      maxLat: Number(testBbox?.maxLat),
      maxLng: Number(testBbox?.maxLng),
    };
    const valid =
      Object.values(box).every(Number.isFinite) &&
      box.minLat < box.maxLat &&
      box.minLng < box.maxLng;

    if (!valid) return null;

    const edge =
      Number(seedTileEdgeKm) > 0 ? Number(seedTileEdgeKm) : DEFAULT_GRID_CONFIG.seedTileEdgeKm;

    try {
      const grid = gridDimensions(box, {
        seedTileEdgeKm: edge,
        minSeedTiles: Math.min(DEFAULT_GRID_CONFIG.minSeedTiles, MAX_SEED_TILES),
        maxSeedTiles: MAX_SEED_TILES,
      });
      return { areaKm2: bboxAreaKm2(box), grid };
    } catch {
      return null;
    }
  })();

  async function onSubmit(values: CreateSearchInput) {
    setSubmitting(true);
    try {
      const response = await fetch("/api/searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("The search could not be created", {
          description:
            payload.error ?? payload.issues?.map((i: { message: string }) => i.message).join(", "),
        });
        return;
      }

      // Creating a search makes NO Google request: planning is free, and only
      // running it bills. The run is a separate, explicit action on the detail
      // page.
      toast.success("Search created", {
        description: `${payload.search.areaKm2.toFixed(1)} km² · ${payload.search.grid.tileCount} tile(s) · nothing has been requested from Google yet.`,
      });

      await queryClient.invalidateQueries({ queryKey: ["searches", "preflight"] });
      router.push(`/searches/${payload.search.searchId}`);
    } catch (error) {
      toast.error("The search could not be created", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Search</CardTitle>
          <CardDescription>
            The grid is built from the rectangle alone. Your lead target is a minimum you want to
            reach — it decides neither how the area is divided nor when the search stops.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="niche">Business niche</Label>
              <Tooltip>
                <TooltipTrigger
                  render={<button type="button" aria-label="About the niche field" />}
                >
                  <Info className="text-muted-foreground size-3.5" />
                </TooltipTrigger>
                <TooltipContent className="max-w-72">
                  Enter the niche alone. Adding the city pulls Google&apos;s ranking back toward the
                  city centre and undoes the tiling.
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              id="niche"
              placeholder="Embroidery Shops"
              aria-invalid={!!errors.niche}
              {...register("niche")}
            />
            <FieldError message={errors.niche?.message} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="country">Country</Label>
              <Input
                id="country"
                placeholder="United States"
                aria-invalid={!!errors.country}
                {...register("country")}
              />
              <FieldError message={errors.country?.message} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="state">State / Region</Label>
              <Input id="state" placeholder="Texas" {...register("state")} />
              <FieldError message={errors.state?.message} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                placeholder="Houston"
                aria-invalid={!!errors.city}
                {...register("city")}
              />
              <FieldError message={errors.city?.message} />
            </div>
          </div>

          <div className="space-y-2 sm:max-w-56">
            <Label htmlFor="targetLeads">Target leads</Label>
            <Input
              id="targetLeads"
              type="number"
              inputMode="numeric"
              min={1}
              aria-invalid={!!errors.targetLeads}
              {...register("targetLeads")}
            />
            <FieldError message={errors.targetLeads?.message} />
            <p className="text-muted-foreground text-xs">
              A <span className="text-foreground font-medium">minimum</span>, not a stopping point.
              The search works through the whole area regardless, so finding more than this is a
              normal result — and covering the area without reaching it is a useful answer about the
              market, not a failure.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="text-muted-foreground size-4" />
            Search area
          </CardTitle>
          <CardDescription>
            The grid is built from this rectangle alone. Automatic city resolution needs the
            Geocoding provider, which is still off, so the box is entered explicitly and no external
            call is made to work out where the city is.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="minLat">Min latitude</Label>
              <Input id="minLat" type="number" step="0.0001" {...register("testBbox.minLat")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="minLng">Min longitude</Label>
              <Input id="minLng" type="number" step="0.0001" {...register("testBbox.minLng")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxLat">Max latitude</Label>
              <Input id="maxLat" type="number" step="0.0001" {...register("testBbox.maxLat")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxLng">Max longitude</Label>
              <Input id="maxLng" type="number" step="0.0001" {...register("testBbox.maxLng")} />
            </div>
          </div>

          <FieldError
            message={errors.testBbox?.minLat?.message ?? errors.testBbox?.minLng?.message}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium tabular-nums">
                {plan === null
                  ? "Invalid rectangle"
                  : `${plan.areaKm2.toFixed(1)} km² · ${plan.grid.cols}×${plan.grid.rows} = ${plan.grid.tileCount} seed tile(s)`}
              </p>
              <p className="text-muted-foreground text-xs">
                {plan === null
                  ? "Every minimum has to be below its matching maximum."
                  : `${plan.grid.tileWidthKm.toFixed(2)}×${plan.grid.tileHeightKm.toFixed(2)} km each. The server refuses anything over ${MAX_AREA_KM2} km² or ${MAX_SEED_TILES} seed tiles.`}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                for (const [key, value] of Object.entries(HOUSTON_INNER_LOOP_TEST_BOX)) {
                  setValue(`testBbox.${key}` as "testBbox.minLat", value, { shouldDirty: true });
                }
              }}
            >
              Reset to the Houston inner loop
            </Button>
          </div>
        </CardContent>
      </Card>

      <PreflightPanel />

      <Accordion
        value={showAdvanced ? ["advanced"] : []}
        onValueChange={(v) => setShowAdvanced((v as string[]).includes("advanced"))}
      >
        <AccordionItem value="advanced" className="rounded-xl border px-4">
          <AccordionTrigger className="text-sm">
            <span className="flex items-center gap-2">
              Advanced grid settings
              <ChevronDown className="size-3.5 opacity-0" />
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-5 pb-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="seedTileEdgeKm">Seed tile edge (km)</Label>
                <Input
                  id="seedTileEdgeKm"
                  type="number"
                  step="0.5"
                  {...register("gridConfig.seedTileEdgeKm")}
                />
                <p className="text-muted-foreground text-xs">
                  The biggest cost lever. Smaller tiles mean better coverage and more API calls.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxSubdivisionDepth">Max subdivision depth</Label>
                <Input
                  id="maxSubdivisionDepth"
                  type="number"
                  {...register("gridConfig.maxSubdivisionDepth")}
                />
                <p className="text-muted-foreground text-xs">
                  How many times a saturated tile may split into four. The server caps this at 3.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="minTileEdgeKm">Min tile edge (km)</Label>
                <Input
                  id="minTileEdgeKm"
                  type="number"
                  step="0.1"
                  {...register("gridConfig.minTileEdgeKm")}
                />
                <p className="text-muted-foreground text-xs">
                  Below this, a saturated tile is recorded as a permanent gap.
                </p>
              </div>
            </div>

            {/*
              There is deliberately no "stop when the target is reached" switch.
              The lead target is a minimum desired benchmark; a search finishes
              when its geography is covered. Offering the old behaviour as an
              option would put back the exact thing that made a 51-lead run over
              83% of its area report itself as complete.

              The field still exists in the schema, because searches created
              before 2026-08-22 froze the old policy and are honoured as
              recorded until their owner presses "Continue to full coverage".
            */}
            <p className="text-muted-foreground rounded-lg border p-3 text-xs">
              <span className="text-foreground font-medium">Completion is geographic.</span> This
              search will keep working through its tiles until the area is covered, the call budget
              is spent, or the free allowance runs out — never because the lead target was met.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <p className="text-muted-foreground rounded-xl border p-4 text-sm">
        Creating a search costs nothing: it plans the grid and writes the rows, and makes no Google
        request at all. Running it is a separate, explicit action on the search page, and every page
        of every tile is reserved against the free allowance before it is requested.
      </p>

      <div className="flex justify-end gap-2">
        <Button type="submit" size="lg" disabled={submitting} className="gap-2">
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitting ? "Creating…" : "Create search"}
        </Button>
      </div>
    </form>
  );
}
