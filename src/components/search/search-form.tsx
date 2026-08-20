"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, Info } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { PhaseNotice } from "@/components/common/phase-notice";
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
import { createSearchSchema, type CreateSearchInput } from "@/lib/schemas/search";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

export function SearchForm() {
  const [showAdvanced, setShowAdvanced] = useState(false);

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
      city: "",
      targetLeads: 500,
      gridConfig: DEFAULT_GRID_CONFIG,
    },
  });

  const stopOnTarget = useWatch({ control, name: "gridConfig.stopOnTargetReached" });

  return (
    <form
      onSubmit={handleSubmit(() => {
        /* Wired in Phase 2: preflight estimate, then POST /api/searches. */
      })}
      className="space-y-6"
      noValidate
    >
      <Card>
        <CardHeader>
          <CardTitle>Search</CardTitle>
          <CardDescription>
            The grid is built from the city&apos;s real bounding box. Your lead target decides when
            to stop, never how the area is divided.
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
              hitting the target is a useful result, not a failure.
            </p>
          </div>
        </CardContent>
      </Card>

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
                  How many times a saturated tile may split into four.
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

      <PhaseNotice phase="Phase 2 — Google Places integration">
        Submitting is disabled until the bounding-box resolver, pricing catalog and budget guard are
        in place. No search may start before the pre-flight estimate can be shown, because that
        estimate is what keeps the run inside the free allowance.
      </PhaseNotice>

      <div className="flex justify-end gap-2">
        <Button type="submit" size="lg" disabled>
          Continue to pre-flight
        </Button>
      </div>
    </form>
  );
}
