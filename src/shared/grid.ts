// Global parcel grid and chunking. Shared by server and client so both derive identical
// parcel boundaries from a parcel id.
//
// Coordinate system: WGS84 longitude/latitude (EPSG:4326), degrees.
// Parcels: rows of CELL_DEG latitude; each row is split into an integer number of columns so
// cells are roughly square (~111 m x ~111 m) at every latitude. Parcel id = "<row>_<col>".
// Chunks: aligned CHUNK_DEG x CHUNK_DEG lat/lng boxes; a parcel belongs to the chunk that
// contains its centre. Chunks are the unit of loading, caching and realtime subscription.

export const CELL_DEG = 0.001;
export const CHUNK_DEG = 0.02;
export const ROWS = Math.round(180 / CELL_DEG);
export const CHUNK_ROWS = Math.round(180 / CHUNK_DEG);
export const CHUNK_COLS = Math.round(360 / CHUNK_DEG);

/** Minimum zoom at which parcels are shown/queried. */
export const PARCEL_MIN_ZOOM = 14;
/** Maximum chunks a single world query may request. */
export const MAX_CHUNKS_PER_REQUEST = 40;

export type LngLat = [number, number];

export function rowOfLat(lat: number): number {
  return Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / CELL_DEG)));
}

export function colsInRow(row: number): number {
  const centerLat = -90 + (row + 0.5) * CELL_DEG;
  return Math.max(1, Math.floor((360 * Math.cos((centerLat * Math.PI) / 180)) / CELL_DEG));
}

function normLng(lng: number): number {
  let x = ((lng + 180) % 360 + 360) % 360;
  if (x === 360) x = 0;
  return x - 180;
}

export function parcelIdAt(lng: number, lat: number): string {
  const row = rowOfLat(lat);
  const n = colsInRow(row);
  const col = Math.min(n - 1, Math.floor(((normLng(lng) + 180) / 360) * n));
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
  const w = 360 / n;
  const south = -90 + p.row * CELL_DEG;
  const west = -180 + p.col * w;
  return { west, south, east: west + w, north: south + CELL_DEG };
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
  const r = Math.min(CHUNK_ROWS - 1, Math.max(0, Math.floor((lat + 90) / CHUNK_DEG)));
  const c = Math.min(CHUNK_COLS - 1, Math.floor((normLng(lng) + 180) / CHUNK_DEG));
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
  const south = -90 + k.row * CHUNK_DEG;
  const west = -180 + k.col * CHUNK_DEG;
  return { west, south, east: west + CHUNK_DEG, north: south + CHUNK_DEG };
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
  for (let row = r0; row <= r1; row++) {
    const centerLat = -90 + (row + 0.5) * CELL_DEG;
    if (centerLat < b.south || centerLat >= b.north) continue;
    const n = colsInRow(row);
    const w = 360 / n;
    const c0 = Math.max(0, Math.floor((b.west + 180) / w - 0.5));
    const c1 = Math.min(n - 1, Math.ceil((b.east + 180) / w));
    for (let col = c0; col <= c1; col++) {
      const centerLng = -180 + (col + 0.5) * w;
      if (centerLng >= b.west && centerLng < b.east) ids.push(`${row}_${col}`);
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
