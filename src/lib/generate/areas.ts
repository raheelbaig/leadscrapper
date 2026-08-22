import type { BoundingBox } from "@/lib/geo/bbox";

/**
 * An area the guided flow can actually search.
 *
 * The list is finite and that is a real product constraint, not a bug to hide:
 * external geocoding is switched off (`EXTERNAL_PROVIDERS_ENABLED` is false),
 * so a rectangle can only come from the shipped fixtures, from an area the user
 * saved themselves, or from one they draw by hand under Advanced. Offering a
 * free-text city box would accept "Tulsa" and then fail after the user had
 * filled in the whole form.
 *
 * So the picker offers what is resolvable and says where the rest comes from.
 */
export type GenerateArea = {
  /** Stable option key: `fixture:<country>|<state>|<city>` or `custom:<uuid>`. */
  id: string;
  kind: "fixture" | "custom";
  /** What the option is called in the list, e.g. "Houston" or "Greater Houston". */
  name: string;
  country: string;
  state: string | null;
  city: string;
  /** Set only for a saved area; the resolver uses it to find the rectangle. */
  customAreaId: string | null;
  bbox: BoundingBox;
};

export function areaOptionId(area: {
  kind: "fixture" | "custom";
  country: string;
  state: string | null;
  city: string;
  customAreaId?: string | null;
}): string {
  return area.kind === "custom"
    ? `custom:${area.customAreaId}`
    : `fixture:${area.country}|${area.state ?? ""}|${area.city}`;
}

/** Distinct countries, in list order, for the first select. */
export function countriesOf(areas: readonly GenerateArea[]): string[] {
  return [...new Set(areas.map((area) => area.country))];
}

/**
 * Distinct states within a country. An area with no state contributes the empty
 * string, which the form renders as "—" rather than dropping the area entirely.
 */
export function statesOf(areas: readonly GenerateArea[], country: string): string[] {
  return [...new Set(areas.filter((a) => a.country === country).map((a) => a.state ?? ""))];
}

export function areasIn(
  areas: readonly GenerateArea[],
  country: string,
  state: string,
): GenerateArea[] {
  return areas.filter((area) => area.country === country && (area.state ?? "") === state);
}
