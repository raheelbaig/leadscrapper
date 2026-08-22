"use client";

import { ChevronDown, Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
 * The one form in the product's normal path.
 *
 * Four questions -- what, where, how many, and may we check their websites --
 * and one button. Everything that used to require walking Find Leads ->
 * Searches -> Run -> Enrichment -> Exports happens after the press.
 *
 * WHAT THE USER APPROVES IS ON SCREEN BEFORE THEY PRESS. The summary states the
 * estimate, the guaranteed maximum for this one approval, the protected quota
 * remaining, and -- when the area is bigger than one approval covers -- that
 * they will be asked again. The numbers are computed with the SAME pure
 * functions the server plans with (`gridDimensions`, `bboxAreaKm2`), so this
 * preview cannot promise a grid the server would build differently.
 *
 * Validation uses the SHARED schema. The browser is not trusted with any of it:
 * the server re-validates, re-derives the grid, and reads the call ceiling from
 * its own constant rather than from anything sent here.
 */

type Quota = { used: number; freeLimit: number; remaining: number };

/**
 * A plain styled `<select>`.
 *
 * Native on purpose. The area picker is three dependent lists whose options
 * change as the ones above them change, and the browser's own control handles
 * that -- plus keyboard, touch and screen-reader behaviour -- without a
 * controlled-popover dance. Styled to sit alongside `Input` so it reads as part
 * of the same design system.
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
  const [targetLeads, setTargetLeads] = useState("40");
  const [enrichEmails, setEnrichEmails] = useState(true);

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
        /** The number being approved: never more than this press permits. */
        guaranteedMax: Math.min(callCeiling, quota.remaining),
        needsSeveralApprovals: estimatedCalls > callCeiling,
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
      enrichEmails,
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

      // Straight to the processing screen. No Searches list, no second Run
      // press, no manual Enrichment step.
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
          <CardTitle>What are you looking for?</CardTitle>
          <CardDescription>
            The kind of business, without the location — the area is handled below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="niche">Business niche</Label>
          <Input
            id="niche"
            value={niche}
            onChange={(event) => setNiche(event.target.value)}
            placeholder="Embroidery Shops"
            autoFocus
          />
          <FieldError message={errors.niche} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where?</CardTitle>
          <CardDescription>
            Choose one of the areas we have boundaries for, or an area you saved earlier.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
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
            <Label htmlFor="area">City / saved area</Label>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How many leads?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="target">Target leads</Label>
          <Input
            id="target"
            inputMode="numeric"
            value={targetLeads}
            onChange={(event) => setTargetLeads(event.target.value)}
            className="max-w-[10rem]"
          />
          <p className="text-muted-foreground text-xs">
            This is a minimum target, not a hard limit. We may find more — the search finishes when
            the area has been covered, not when this number is reached.
          </p>
          <FieldError message={errors.targetLeads} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Business emails</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox
              checked={enrichEmails}
              onCheckedChange={(checked) => setEnrichEmails(checked === true)}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">
                Check public business websites for contact emails
              </span>
              <span className="text-muted-foreground block text-xs">
                Google never returns an email address, so we visit each business&rsquo;s own website
                and look. We read their robots.txt first and check at most a handful of pages per
                business, one business at a time.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      {/* ---------------- Pre-flight ---------------- */}
      <Card className="border-primary/30 bg-primary/[0.03]">
        <CardHeader>
          <CardTitle>Ready to generate</CardTitle>
          <CardDescription>What this one press approves.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-base font-semibold">{niche.trim() || "Your niche"}</p>
            <p className="text-muted-foreground text-sm">
              {selected
                ? [selected.name, selected.state, selected.country].filter(Boolean).join(", ")
                : "No area selected"}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Minimum leads" value={formatNumber(Number(targetLeads) || 0)} />
            <Figure
              label="Estimated Google requests"
              value={plan ? `~${formatNumber(plan.estimatedCalls)}` : "—"}
              hint={plan ? `${formatNumber(plan.areas)} areas to search` : undefined}
            />
            <Figure
              label="Maximum for this approval"
              value={plan ? formatNumber(plan.guaranteedMax) : formatNumber(callCeiling)}
              hint="guaranteed, not an estimate"
              emphasis
            />
            <Figure
              label="Protected quota remaining"
              value={formatNumber(quota.remaining)}
              hint={`${formatNumber(quota.used)} of ${formatNumber(quota.freeLimit)} used this month`}
            />
          </div>

          {plan?.needsSeveralApprovals ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
              This area is likely to need about {formatNumber(plan.estimatedCalls)} requests to
              cover completely — more than one approval allows. This run will stop at{" "}
              {formatNumber(plan.guaranteedMax)} and ask you before going further. Nothing continues
              without you.
            </p>
          ) : null}

          <p className="text-muted-foreground text-xs">
            Email enrichment:{" "}
            <span className="text-foreground font-medium">{enrichEmails ? "ON" : "OFF"}</span>
            {enrichEmails
              ? " — we will check the websites of the businesses we find."
              : " — we will collect businesses only."}
          </p>

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

          {blocked ? (
            <p className="text-xs text-red-600 dark:text-red-400">
              Your free monthly Google search capacity has been reached. Nothing will be requested
              until the billing month resets.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- What happens next ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What happens after you press Generate Leads?</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="text-muted-foreground list-decimal space-y-1.5 pl-4 text-sm">
            <li>We search businesses across your selected area, section by section.</li>
            <li>
              We remove duplicates, within this search and against everything you have found before.
            </li>
            <li>We check public business websites for contact emails.</li>
            <li>We prepare your Excel file.</li>
          </ol>
        </CardContent>
      </Card>

      {/* ---------------- Advanced ---------------- */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", showAdvanced && "rotate-180")}
          />
          Advanced / technical details
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
              To search somewhere else, draw the area once under{" "}
              <a href="/settings" className="text-foreground underline">
                Settings
              </a>{" "}
              and it will appear in this list as a saved area.
            </p>
            {plan && selected ? (
              <p>
                Selected rectangle: {plan.areaKm2.toFixed(0)} km², tiled into {plan.areas} sections
                at a {DEFAULT_GRID_CONFIG.seedTileEdgeKm} km seed edge. Section count follows from
                the rectangle alone — the lead target has no influence on it.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}

function Figure({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className={cn("text-base font-semibold tabular-nums", emphasis && "text-primary")}>
        {value}
      </p>
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}
