// Global parcel grid and chunking. Shared by server and client so both derive identical
// parcel boundaries from a parcel id.
//
// Coordinate system: WGS84 longitude/latitude (EPSG:4326), degrees.
// Parcels: rows of CELL_DEG latitude; each row is split into an integer number of columns so
// cells are roughly square (~111 m x ~111 m) at every latitude. Parcel id = "<row>_<col>".
// Chunks: aligned CHUNK_DEG x CHUNK_DEG lat/lng boxes; a parcel belongs to the chunk that
// contains its centre. Chunks are the unit of loading, caching and realtime subscription.

export const CELLS_PER_DEG = 1000;
export const CHUNKS_PER_DEG = 50;
export const CELL_DEG = 1 / CELLS_PER_DEG;
export const CHUNK_DEG = 1 / CHUNKS_PER_DEG;
export const ROWS = 180 * CELLS_PER_DEG;
export const CHUNK_ROWS = 180 * CHUNKS_PER_DEG;
export const CHUNK_COLS = 360 * CHUNKS_PER_DEG;

// Boundaries are computed as integer / integer so they are the nearest doubles to the exact values,
// and index lookups are corrected against those same boundaries. This keeps parcelIdAt() and
// parcelBounds() consistent even for points that lie exactly on an edge.
const rowSouth = (row: number) => (row - 90 * CELLS_PER_DEG) / CELLS_PER_DEG;
const colWest = (col: number, n: number) => (col * 360) / n - 180;
const chunkSouth = (r: number) => (r - 90 * CHUNKS_PER_DEG) / CHUNKS_PER_DEG;
const chunkWest = (c: number) => (c - 180 * CHUNKS_PER_DEG) / CHUNKS_PER_DEG;

function fixIndex(i: number, max: number, lo: (i: number) => number, x: number): number {
  i = Math.min(max - 1, Math.max(0, i));
  if (i > 0 && x < lo(i)) i--;
  else if (i < max - 1 && x >= lo(i + 1)) i++;
  return i;
}

/** Minimum zoom at which parcels are shown/queried. */
export const PARCEL_MIN_ZOOM = 14;
/** Maximum chunks a single world query may request. */
export const MAX_CHUNKS_PER_REQUEST = 40;

export type LngLat = [number, number];

export function rowOfLat(lat: number): number {
  return fixIndex(Math.floor((lat + 90) * CELLS_PER_DEG), ROWS, rowSouth, lat);
}

export function colsInRow(row: number): number {
  const centerLat = rowSouth(row) + CELL_DEG / 2;
  return Math.max(1, Math.floor(360 * CELLS_PER_DEG * Math.cos((centerLat * Math.PI) / 180)));
}

function normLng(lng: number): number {
  let x = ((lng + 180) % 360 + 360) % 360;
  if (x === 360) x = 0;
  return x - 180;
}

export function parcelIdAt(lng: number, lat: number): string {
  const row = rowOfLat(lat);
  const n = colsInRow(row);
  const x = normLng(lng);
  const col = fixIndex(Math.floor(((x + 180) / 360) * n), n, (c) => colWest(c, n), x);
  return `${row}_${col}`;
}

export function parseParcelId(id: string): { row: number; col: number } | null {
  const m = /^(\d{1,6})_(\d{1,7})$/.exec(id);
  if (!m) return null;
  const row = Number(m[1]);
  const col = Number(m[2]);
  if (row < 0 || row >= ROWS || col < 0 || col >= colsInRow(row)) return null;
  return { row, col };
}

export interface ParcelBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function parcelBounds(id: string): ParcelBounds {
  const p = parseParcelId(id);
  if (!p) throw new Error(`invalid parcel id ${id}`);
  const n = colsInRow(p.row);
  return { west: colWest(p.col, n), south: rowSouth(p.row), east: colWest(p.col + 1, n), north: rowSouth(p.row + 1) };
}

export function parcelCenter(id: string): LngLat {
  const b = parcelBounds(id);
  return [(b.west + b.east) / 2, (b.south + b.north) / 2];
}

/** Closed polygon ring (GeoJSON order) for a parcel. */
export function parcelRing(id: string): LngLat[] {
  const b = parcelBounds(id);
  return [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
  ];
}

export function chunkKeyAt(lng: number, lat: number): string {
  const x = normLng(lng);
  const r = fixIndex(Math.floor((lat + 90) * CHUNKS_PER_DEG), CHUNK_ROWS, chunkSouth, lat);
  const c = fixIndex(Math.floor((x + 180) * CHUNKS_PER_DEG), CHUNK_COLS, chunkWest, x);
  return `${r}_${c}`;
}

export function parseChunkKey(key: string): { row: number; col: number } | null {
  const m = /^(\d{1,5})_(\d{1,5})$/.exec(key);
  if (!m) return null;
  const row = Number(m[1]);
  const col = Number(m[2]);
  if (row >= CHUNK_ROWS || col >= CHUNK_COLS) return null;
  return { row, col };
}

export function chunkBounds(key: string): ParcelBounds {
  const k = parseChunkKey(key);
  if (!k) throw new Error(`invalid chunk key ${key}`);
  return { west: chunkWest(k.col), south: chunkSouth(k.row), east: chunkWest(k.col + 1), north: chunkSouth(k.row + 1) };
}

export function chunkOfParcel(id: string): string {
  const [lng, lat] = parcelCenter(id);
  return chunkKeyAt(lng, lat);
}

/** All parcel ids whose centre lies inside the chunk. */
export function parcelsInChunk(key: string): string[] {
  const b = chunkBounds(key);
  const ids: string[] = [];
  const r0 = rowOfLat(b.south + CELL_DEG / 2);
  const r1 = rowOfLat(b.north - CELL_DEG / 2);
  for (let row = Math.max(0, r0 - 1); row <= Math.min(ROWS - 1, r1 + 1); row++) {
    const n = colsInRow(row);
    const w = 360 / n;
    const c0 = Math.max(0, Math.floor((b.west + 180) / w) - 1);
    const c1 = Math.min(n - 1, Math.ceil((b.east + 180) / w) + 1);
    for (let col = c0; col <= c1; col++) {
      const id = `${row}_${col}`;
      if (chunkOfParcel(id) === key) ids.push(id);
    }
  }
  return ids;
}

/** Chunk keys covering a bounding box (no antimeridian wrapping beyond clamping). */
export function chunksInBounds(west: number, south: number, east: number, north: number): string[] {
  const keys: string[] = [];
  const r0 = Math.max(0, Math.floor((Math.max(-90, south) + 90) / CHUNK_DEG));
  const r1 = Math.min(CHUNK_ROWS - 1, Math.floor((Math.min(90, north) + 90) / CHUNK_DEG));
  const c0 = Math.max(0, Math.floor((Math.max(-180, west) + 180) / CHUNK_DEG));
  const c1 = Math.min(CHUNK_COLS - 1, Math.floor((Math.min(180, east) + 180) / CHUNK_DEG));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) keys.push(`${r}_${c}`);
  return keys;
}
