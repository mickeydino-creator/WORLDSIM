// Client-side placement pre-check for instant feedback. The server re-validates everything.
import { getBuildingDef } from '@/shared/config/buildings';
import { LAND_CLASSES } from '@/shared/config/land';
import { footprintRing, ringWithin, ringsOverlap } from '@/shared/geo';
import { chunkOfParcel, parcelIdAt, parcelRing } from '@/shared/grid';
import type { Chunk, Me } from '../types';

export interface PlacementCheck { parcelId: string; valid: boolean; blocking: boolean; reason: string | null }

export function checkPlacement(type: string, lngLat: [number, number], rotation: number, me: Me | null, chunks: Map<string, Chunk>): PlacementCheck {
  const def = getBuildingDef(type);
  const parcelId = parcelIdAt(lngLat[0], lngLat[1]);
  const bad = (reason: string, blocking = true): PlacementCheck => ({ parcelId, valid: false, blocking, reason });
  if (!def || !me) return bad('Loading...');
  const chunk = chunks.get(chunkOfParcel(parcelId));
  if (!chunk) return bad('Loading parcel data...');
  const cls = chunk.cells[parcelId];
  if (!cls || !LAND_CLASSES[cls].purchasable) return bad(`Cannot build on ${cls ? LAND_CLASSES[cls].name.toLowerCase() : 'this location'}`);
  const owner = chunk.parcels.find((p) => p.id === parcelId);
  if (!owner) return bad('This parcel is unowned. Buy it first.');
  if (owner.settlementId) {
    if (owner.settlementId !== me.settlement?.id) return bad(`Settlement land of ${owner.settlementName}`);
    if (def.effects.recipes?.length) return bad('Settlement land is zoned for civic, residential and infrastructure buildings');
  } else if (owner.ownerId !== me.id) {
    return bad(`Owned by ${owner.ownerName ?? 'another player'}. You need their build permission.`, false);
  }
  const req = def.requirements;
  if (req.landClasses && !req.landClasses.includes(cls)) return bad(`${def.name} is not allowed on ${LAND_CLASSES[cls].name.toLowerCase()}`);
  if (req.settlementLandOnly && !owner.settlementId) return bad(`${def.name} must be built on settlement land`);
  if (req.minLevel && me.level < req.minLevel) return bad(`Requires level ${req.minLevel}`);
  const missing = (req.research ?? []).filter((t) => !me.techs.includes(t));
  if (missing.length) return bad(`Requires research: ${missing.join(', ')}`);
  const cost = Math.round(def.cost * me.modifiers.buildCostMultiplier);
  if (me.balance < cost) return bad('Insufficient funds');
  const ring = footprintRing(lngLat, def.width, def.depth, rotation);
  if (!ringWithin(ring, parcelRing(parcelId))) return bad('Must fit entirely inside the parcel');
  for (const b of chunk.buildings) {
    if (b.parcelId !== parcelId) continue;
    const bd = getBuildingDef(b.type);
    if (!bd) continue;
    if (ringsOverlap(ring, footprintRing([b.lng, b.lat], bd.width, bd.depth, b.rotation))) return bad(`Overlaps ${bd.name}`);
  }
  return { parcelId, valid: true, blocking: false, reason: null };
}

/** Finds the building whose footprint contains the point (for click selection). */
export function buildingAt(lngLat: [number, number], chunks: Map<string, Chunk>) {
  const chunk = chunks.get(chunkOfParcel(parcelIdAt(lngLat[0], lngLat[1])));
  if (!chunk) return null;
  for (const b of chunk.buildings) {
    const def = getBuildingDef(b.type);
    if (!def) continue;
    const ring = footprintRing([b.lng, b.lat], def.width + 2, def.depth + 2, b.rotation);
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lngLat[1] !== yj > lngLat[1] && lngLat[0] < ((xj - xi) * (lngLat[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return b;
  }
  return null;
}
