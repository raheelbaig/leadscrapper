"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Info, Loader2, MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { PhaseNotice } from "@/components/common/phase-notice";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEFAULT_GRID_CONFIG } from "@/lib/constants";
import { bboxAreaKm2, gridDimensions } from "@/lib/geo/bbox";
import { createSearchSchema, type CreateSearchInput } from "@/lib/schemas/search";

/**
 * A ~254 km2 rectangle over the Houston inner loop: about 15.5 x 16.4 km.
 *
 * Deliberately NOT the Houston city bounding box, which is roughly 3,700 km2
 * and would plan a 90-tile crawl. At the 8 km seed edge this box tiles into a
 * 3 x 2 grid -- six tiles, inside the controlled 4-9 band, and large enough per
 * tile that pagination to page 2 is actually exercised rather than theorised.
 */
const HOUSTON_INNER_LOOP_TEST_BOX = {
  minLat: 29.69,
  minLng: -95.45,
  maxLat: 29.83,
  maxLng: -95.28,
} as const;

/**
 * Mirrors PHASE_3B_LIMITS. The server is authoritative and refuses anything
 * past these on its own; they are repeated here only so the form can warn
 * before a submission that would be rejected.
 */
const PHASE_3B_MAX_AREA_KM2 = 300;
const PHASE_3B_MAX_SEED_TILES = 9;

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

  const stopOnTarget = useWatch({ control, name: "gridConfig.stopOnTargetReached" });
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
        minSeedTiles: Math.min(DEFAULT_GRID_CONFIG.minSeedTiles, PHASE_3B_MAX_SEED_TILES),
        maxSeedTiles: PHASE_3B_MAX_SEED_TILES,
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
            The grid is built from the rectangle alone. Your lead target decides when to stop, never
            how the area is divided.
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
              A city may simply not list this many businesses. Reaching full coverage without
              hitting the target is a useful result, not a failure. Phase 3B caps this at 50.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="text-muted-foreground size-4" />
            Controlled test area
          </CardTitle>
          <CardDescription>
            Phase 3B searches a district, not a whole city. The grid is built from this box alone —
            automatic city resolution needs the Geocoding provider, which is still off.
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
                  : `${plan.grid.tileWidthKm.toFixed(2)}×${plan.grid.tileHeightKm.toFixed(2)} km each. The server refuses anything over ${PHASE_3B_MAX_AREA_KM2} km² or ${PHASE_3B_MAX_SEED_TILES} seed tiles in this phase.`}
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
                  How many times a saturated tile may split into four. Phase 3B caps this at 1.
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

            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="stopOnTargetReached">Stop when the target is reached</Label>
                <p className="text-muted-foreground text-xs">
                  On: stop early and report exactly which areas went unsearched. Off: sweep the
                  whole city regardless of the target.
                </p>
              </div>
              <Switch
                id="stopOnTargetReached"
                checked={!!stopOnTarget}
                onCheckedChange={(checked) =>
                  setValue("gridConfig.stopOnTargetReached", checked, { shouldDirty: true })
                }
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <PhaseNotice phase="Phase 3A — controlled test">
        Creating a search costs nothing: it plans the grid and writes the rows, and makes no Google
        request. Running it is a separate, explicit action on the search page, and it fetches a
        single page of a single tile.
      </PhaseNotice>

      <div className="flex justify-end gap-2">
        <Button type="submit" size="lg" disabled={submitting} className="gap-2">
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitting ? "Creating…" : "Create controlled test"}
        </Button>
      </div>
    </form>
  );
}
