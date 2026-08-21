import { bboxHeightKm, bboxWidthKm } from "@/lib/geo/bbox";
import { TILE_STATE_META, type TileState } from "@/lib/tile-states";

/**
 * The coverage map: one rectangle per leaf tile, coloured by state.
 *
 * Plain inline SVG, and deliberately not a mapping library. There is no base
 * map, no tiles to fetch and no attribution to satisfy -- the only question it
 * answers is "which parts of the rectangle have actually been searched", and a
 * grid of coloured rectangles answers that better than a street map would.
 * It also keeps the promise that nothing but the Places client makes an
 * outbound request.
 *
 * Only LEAVES are drawn. A `subdivided` tile is a container whose children
 * cover it exactly, so drawing it as well would paint over the very detail the
 * subdivision was performed to reveal.
 *
 * A server component: every colour on it comes from a database row, so it
 * re-renders when the page does and holds no state of its own.
 */

export type MapTile = {
  id: string;
  label: string;
  state: string;
  depth: number;
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
};

export type TileMapProps = {
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  tiles: MapTile[];
  /** Outlined while a run is working on it. */
  currentTileId?: string | null;
};

const WIDTH = 1000;

export function TileMap({ bbox, tiles, currentTileId }: TileMapProps) {
  const lngSpan = bbox.maxLng - bbox.minLng;
  const latSpan = bbox.maxLat - bbox.minLat;

  if (lngSpan <= 0 || latSpan <= 0 || tiles.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        The grid has not been laid out yet.
      </p>
    );
  }

  // The viewBox keeps the real proportions of the area: longitude degrees are
  // narrower than latitude degrees away from the equator, and a square-looking
  // map of a wide rectangle would misrepresent where the coverage gaps are.
  const widthKm = bboxWidthKm(bbox);
  const heightKm = bboxHeightKm(bbox);
  const height = Math.round(WIDTH * (heightKm / Math.max(widthKm, 0.0001)));

  const x = (lng: number) => ((lng - bbox.minLng) / lngSpan) * WIDTH;
  // Latitude grows northward, SVG y grows downward.
  const y = (lat: number) => ((bbox.maxLat - lat) / latSpan) * height;

  const leaves = tiles
    .filter((tile) => tile.state !== "subdivided")
    .sort((a, b) => a.depth - b.depth);

  const showLabels = leaves.length <= 16;

  return (
    <figure className="space-y-2">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          className="bg-muted/30 ring-border h-auto w-full rounded-md ring-1"
          role="img"
          aria-label={`Coverage map: ${leaves.length} leaf tiles over ${widthKm.toFixed(1)} by ${heightKm.toFixed(1)} kilometres.`}
        >
          {leaves.map((tile) => {
            const meta = TILE_STATE_META[tile.state as TileState];
            const left = x(tile.min_lng);
            const top = y(tile.max_lat);
            const w = x(tile.max_lng) - left;
            const h = y(tile.min_lat) - top;
            const isCurrent = tile.id === currentTileId;

            return (
              <g key={tile.id}>
                <rect
                  x={left}
                  y={top}
                  width={w}
                  height={h}
                  fill={meta?.fill ?? "transparent"}
                  stroke={isCurrent ? "currentColor" : "rgba(120,120,120,0.45)"}
                  strokeWidth={isCurrent ? 5 : 1.5}
                >
                  {/* Native SVG tooltip: no client JavaScript to render a hint. */}
                  <title>{`${tile.label} — ${meta?.label ?? tile.state}: ${meta?.description ?? ""}`}</title>
                </rect>
                {showLabels ? (
                  <text
                    x={left + w / 2}
                    y={top + h / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={Math.min(w, h) / 5}
                    fill="currentColor"
                    opacity={0.55}
                    className="font-mono"
                  >
                    {tile.label.replace(/^Tile #/, "")}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="text-muted-foreground text-[11px]">
        {leaves.length} leaf tile(s) over {widthKm.toFixed(1)} × {heightKm.toFixed(1)} km. A
        subdivided tile is not drawn — its four children cover it exactly.
      </figcaption>
    </figure>
  );
}
