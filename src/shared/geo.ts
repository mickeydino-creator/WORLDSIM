import type { LngLat } from './grid';

const M_PER_DEG_LAT = 111_320;

export function metersToLngLat(origin: LngLat, east: number, north: number): LngLat {
  const [lng, lat] = origin;
  return [lng + east / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)), lat + north / M_PER_DEG_LAT];
}

export function lngLatToMeters(origin: LngLat, p: LngLat): { east: number; north: number } {
  const [lng, lat] = origin;
  return {
    east: (p[0] - lng) * M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180),
    north: (p[1] - lat) * M_PER_DEG_LAT,
  };
}

/**
 * Rotated rectangle footprint as a closed GeoJSON ring.
 * rotationDeg is clockwise from north; at 0 the width runs east-west and the depth north-south.
 */
export function footprintRing(center: LngLat, width: number, depth: number, rotationDeg: number): LngLat[] {
  const t = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const hw = width / 2;
  const hd = depth / 2;
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  const ring = corners.map(([e, n]) => metersToLngLat(center, e * cos + n * sin, -e * sin + n * cos));
  ring.push(ring[0]);
  return ring;
}

/** Point-in-polygon (ray casting) for a single ring. */
export function pointInRing(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const o = (p: LngLat, q: LngLat, r: LngLat) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Client-side overlap pre-check for convex rings (server re-validates with PostGIS). */
export function ringsOverlap(a: LngLat[], b: LngLat[]): boolean {
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++) if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return pointInRing(a[0], b) || pointInRing(b[0], a);
}

export function ringWithin(inner: LngLat[], outer: LngLat[]): boolean {
  return inner.slice(0, -1).every((p) => pointInRing(p, outer));
}

export function distanceMeters(a: LngLat, b: LngLat): number {
  const { east, north } = lngLatToMeters(a, b);
  return Math.hypot(east, north);
}
