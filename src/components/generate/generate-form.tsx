"use client";

import { ChevronDown, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_GRID_CONFIG, INITIAL_AVG_PAGES_PER_TILE } from "@/lib/constants";
import { formatNumber } from "@/lib/format";
import {
  areaOptionId,
  areasIn,
  countriesOf,
  statesOf,
  type GenerateArea,
} from "@/lib/generate/areas";
import { bboxAreaKm2, gridDimensions } from "@/lib/geo/bbox";
import { createGenerationSchema } from "@/lib/schemas/generate";
import { cn } from "@/lib/utils";

/**
 * The first screen of the product, and for most sessions the only one that
 * needs a decision.
 *
 * ONE CARD, FIVE QUESTIONS, ONE BUTTON. This was five stacked cards with their
 * own headings, which read as a five-step configuration wizard for what is
 * really a short form. Nothing was removed -- every input is still here -- but
 * the scaffolding around them is gone.
 *
 * EMAIL DISCOVERY IS NO LONGER A CHOICE. It used to be a checkbox; it is now
 * simply part of what Generate Leads means, stated in the sentence under the
 * button. The consent is still recorded as a timestamp on the run, and the
 * orchestrator still refuses to reach a single website without it -- what
 * changed is that the user is told plainly instead of being asked to opt in to
 * the thing they came for.
 *
 * USAGE STAYS VISIBLE WITHOUT A PAGE OF ITS OWN. Two figures in the user's
 * terms: what this run may spend and what the month has left. SKUs, reserves
 * and quota mechanics live under Technical details.
 *
 * The estimate is computed with the SAME pure functions the server plans with
 * (`gridDimensions`, `bboxAreaKm2`), so this preview cannot promise a grid the
 * server would build differently. Validation uses the SHARED schema, and the
 * server re-validates everything and reads its own limits regardless.
 */

type Quota = { used: number; freeLimit: number; remaining: number };

/**
 * A plain styled `<select>`.
 *
 * Native on purpose. The area picker is three dependent lists whose options
 * change as the ones above them change, and the browser's own control handles
 * that -- plus keyboard, touch and screen-reader behaviour -- without a
 * controlled-popover dance.
 */
function FieldSelect({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 h-9 w-full rounded-lg border px-3 text-sm transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

export function GenerateForm({
  areas,
  quota,
  callCeiling,
}: {
  areas: GenerateArea[];
  quota: Quota;
  /** `GENERATION_LIMITS.maxGoogleCallsPerRun`, passed in — the server owns it. */
  callCeiling: number;
}) {
  const router = useRouter();

  const countries = useMemo(() => countriesOf(areas), [areas]);

  const [niche, setNiche] = useState("");
  const [country, setCountry] = useState(countries[0] ?? "");
  const states = useMemo(() => statesOf(areas, country), [areas, country]);
  const [state, setState] = useState(states[0] ?? "");
  const options = useMemo(() => areasIn(areas, country, state), [areas, country, state]);
  const [areaId, setAreaId] = useState(options[0] ? areaOptionId(options[0]) : "");
  const [targetLeads, setTargetLeads] = useState("100");

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const selected = options.find((option) => areaOptionId(option) === areaId) ?? options[0] ?? null;

  // Keeps the dependent lists coherent when a parent changes.
  function onCountryChange(next: string) {
    setCountry(next);
    const nextStates = statesOf(areas, next);
    const nextState = nextStates[0] ?? "";
    setState(nextState);
    const nextAreas = areasIn(areas, next, nextState);
    setAreaId(nextAreas[0] ? areaOptionId(nextAreas[0]) : "");
  }

  function onStateChange(next: string) {
    setState(next);
    const nextAreas = areasIn(areas, country, next);
    setAreaId(nextAreas[0] ? areaOptionId(nextAreas[0]) : "");
  }

  // The same coverage-first sizing the server performs. Target leads have ZERO
  // influence on the geometry, here or there.
  const plan = useMemo(() => {
    if (!selected) return null;
    try {
      const grid = gridDimensions(selected.bbox, {
        seedTileEdgeKm: DEFAULT_GRID_CONFIG.seedTileEdgeKm,
        minSeedTiles: DEFAULT_GRID_CONFIG.minSeedTiles,
        maxSeedTiles: DEFAULT_GRID_CONFIG.maxSeedTiles,
      });
      const estimatedCalls = Math.ceil(grid.tileCount * INITIAL_AVG_PAGES_PER_TILE);
      return {
        areaKm2: bboxAreaKm2(selected.bbox),
        areas: grid.tileCount,
        estimatedCalls,
        /** Never more than this run may spend. */
        guaranteedMax: Math.min(callCeiling, quota.remaining),
        largerThanOneRun: estimatedCalls > callCeiling,
      };
    } catch {
      return null;
    }
  }, [selected, callCeiling, quota.remaining]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;

    const candidate = {
      niche,
      country: selected.country,
      state: selected.state ?? "",
      city: selected.city,
      customAreaId: selected.customAreaId ?? undefined,
      targetLeads,
      // Email discovery is part of what Generate Leads means. The server still
      // records the consent and still gates every external request on it.
      enrichEmails: true,
    };

    const parsed = createGenerationSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }

    setErrors({});
    setSubmitting(true);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const payload = await response.json();

      if (!response.ok) {
        toast.error("We could not start this generation", { description: payload.error });
        return;
      }

      router.push(`/generate/${payload.runId}`);
    } catch (error) {
      toast.error("We could not start this generation", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const blocked = quota.remaining <= 0;

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Find local businesses</CardTitle>
          <CardDescription>
            Tell us what you are looking for and where, and we will do the rest.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="niche">Business niche</Label>
            <Input
              id="niche"
              value={niche}
              onChange={(event) => setNiche(event.target.value)}
              placeholder="Embroidery Shops"
              autoFocus
            />
            <FieldError message={errors.niche} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="country">Country</Label>
              <FieldSelect
                id="country"
                value={country}
                onChange={(event) => onCountryChange(event.target.value)}
              >
                {countries.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </FieldSelect>
            </div>

            <div className="space-y-2">
              <Label htmlFor="state">State / region</Label>
              <FieldSelect
                id="state"
                value={state}
                onChange={(event) => onStateChange(event.target.value)}
              >
                {states.map((item) => (
                  <option key={item} value={item}>
                    {item === "" ? "—" : item}
                  </option>
                ))}
              </FieldSelect>
            </div>

            <div className="space-y-2">
              <Label htmlFor="area">City / area</Label>
              <FieldSelect
                id="area"
                value={areaId}
                onChange={(event) => setAreaId(event.target.value)}
              >
                {options.map((option) => (
                  <option key={areaOptionId(option)} value={areaOptionId(option)}>
                    {option.name}
                    {option.kind === "custom" ? " (saved area)" : ""}
                  </option>
                ))}
              </FieldSelect>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target">Target leads</Label>
            <Input
              id="target"
              inputMode="numeric"
              value={targetLeads}
              onChange={(event) => setTargetLeads(event.target.value)}
              className="max-w-40"
            />
            <p className="text-muted-foreground text-xs">
              A minimum, not a limit. We keep going until the whole area has been searched, so you
              may well get more.
            </p>
            <FieldError message={errors.targetLeads} />
          </div>

          <Button
            type="submit"
            size="lg"
            className="w-full gap-2"
            disabled={submitting || !selected || blocked}
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {blocked ? "Monthly capacity reached" : submitting ? "Starting…" : "Generate Leads"}
          </Button>

          <p className="text-muted-foreground text-sm">
            We&rsquo;ll find businesses in your selected area, collect their public business
            information, and automatically look for public contact emails.
          </p>

          {blocked ? (
            <p className="text-xs text-red-600 dark:text-red-400">
              Your free monthly Google search capacity has been reached. Nothing will be requested
              until it resets.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-6 gap-y-1 px-1 text-xs">
        <span>
          This search may use up to{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {formatNumber(plan?.guaranteedMax ?? callCeiling)}
          </span>{" "}
          Google requests
        </span>
        <span>
          Monthly usage{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {formatNumber(quota.used)} / {formatNumber(quota.freeLimit)}
          </span>
        </span>
        {plan ? (
          <span>
            Estimated for this area{" "}
            <span className="text-foreground font-semibold tabular-nums">
              ~{formatNumber(plan.estimatedCalls)}
            </span>
          </span>
        ) : null}
      </div>

      {plan?.largerThanOneRun ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
          This area is large. Covering it completely is likely to take about{" "}
          {formatNumber(plan.estimatedCalls)} requests, more than the{" "}
          {formatNumber(plan.guaranteedMax)} this search may make, so expect it to stop partway and
          tell you which area it did not reach. Nothing is spent beyond the limit.
        </p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", showAdvanced && "rotate-180")}
          />
          Technical details
        </button>

        {showAdvanced ? (
          <div className="text-muted-foreground mt-3 space-y-2 rounded-lg border p-4 text-xs">
            <p>
              <span className="text-foreground font-medium">Why only these areas?</span> A search
              needs a real rectangle before it can be divided into sections, and looking one up is
              itself a billable Google request. External boundary lookups are switched off, so the
              list offers the areas we already have boundaries for, plus any you have saved.
            </p>
            <p>
              Only free Google usage is ever made. {formatNumber(quota.remaining)} request(s) remain
              in this month&rsquo;s protected allowance, and a run stops rather than going past it.
            </p>
            {plan && selected ? (
              <p>
                Selected rectangle: {plan.areaKm2.toFixed(0)} km², divided into {plan.areas}{" "}
                sections at a {DEFAULT_GRID_CONFIG.seedTileEdgeKm} km edge. Section count follows
                from the rectangle alone — the lead target has no influence on it.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}
