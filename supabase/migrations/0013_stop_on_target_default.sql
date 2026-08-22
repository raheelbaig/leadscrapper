-- 0013_stop_on_target_default.sql
-- The lead target stops being a termination condition.
--
-- PRODUCT DECISION (2026-08-22): `target_leads` is a MINIMUM DESIRED BENCHMARK,
-- not a stopping rule. A search that wanted 40 leads and has found 87 keeps
-- working through its pending tiles; the only terminal success is complete
-- geographic coverage. "Target exceeded" is a metric to report, never a reason
-- a run ended.
--
-- Two things change here and nothing else:
--
--   1. The COLUMN DEFAULT for app_settings.grid_defaults, so every search
--      created from now on inherits stopOnTargetReached = false. This mirrors
--      DEFAULT_GRID_CONFIG in src/lib/constants.ts, which is the value the
--      application actually reads; the two are kept in step deliberately.
--
--   2. The settings row(s) that already exist, which still carry the old
--      default and would otherwise hand the old policy to every new search.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH: searches.grid_config. Those rows are
-- frozen at creation because they are the definition every cost estimate and
-- every laid-out tile was derived from, and rewriting them would silently
-- restate history. The one existing search that carries
-- stopOnTargetReached = true keeps it until a person presses "Continue to full
-- coverage", which flips exactly that key and appends a stop_policy_amended
-- event. See src/server/search/manage-search.ts :: amendStopPolicy.

alter table public.app_settings
  alter column grid_defaults set default jsonb_build_object(
    'sizingStrategy',       'coverage-first',
    'seedTileEdgeKm',       8,
    'maxSubdivisionDepth',  3,
    'minTileEdgeKm',        0.5,
    'saturationRatio',      0.95,
    'minSeedTiles',         4,
    'maxSeedTiles',         400,
    'stopOnTargetReached',  false
  );

-- Existing rows: flip only this one key, leaving any other customisation the
-- user has made to their grid defaults untouched.
update public.app_settings
set grid_defaults = jsonb_set(grid_defaults, '{stopOnTargetReached}', 'false'::jsonb, true)
where grid_defaults -> 'stopOnTargetReached' is distinct from 'false'::jsonb;
