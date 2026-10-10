import { describe, expect, it } from 'vitest';
import { BUILDINGS, getBuildingDef } from '@/shared/config/buildings';
import { RECIPES } from '@/shared/config/recipes';
import { TECHS, getTech } from '@/shared/config/research';
import { isResourceId } from '@/shared/config/resources';
import { PROJECT_TYPES } from '@/shared/config/settlements';
import { footprintRing, lngLatToMeters, ringWithin } from '@/shared/geo';
import { chunkOfParcel, parcelBounds, parcelIdAt, parcelRing, parcelsInChunk } from '@/shared/grid';
import { levelForXp } from '@/shared/config/progression';

describe('catalog configuration', () => {
  it('every building has a model, valid resources and known research', () => {
    for (const b of BUILDINGS) {
      expect(b.model.length, b.type).toBeGreaterThan(0);
      for (const r of Object.keys(b.resources)) expect(isResourceId(r), `${b.type}:${r}`).toBe(true);
      for (const t of b.requirements.research ?? []) expect(getTech(t), `${b.type} needs ${t}`).toBeDefined();
      for (const t of b.requirements.requiresOwned ?? []) expect(getBuildingDef(t)).toBeDefined();
      expect(b.width).toBeLessThanOrEqual(100);
    }
  });

  it('research unlocks match building requirements', () => {
    for (const t of TECHS) {
      for (const p of t.prereqs) expect(getTech(p)).toBeDefined();
      for (const b of t.effects.unlockBuildings ?? []) expect(getBuildingDef(b)?.requirements.research).toContain(t.id);
    }
  });

  it('recipes reference existing buildings and resources', () => {
    for (const r of RECIPES) {
      const b = getBuildingDef(r.building);
      expect(b?.effects.recipes, r.id).toContain(r.id);
      for (const k of [...Object.keys(r.inputs), ...Object.keys(r.outputs)]) expect(isResourceId(k)).toBe(true);
    }
  });

  it('project types reference buildings', () => {
    for (const p of PROJECT_TYPES) if (p.building) expect(getBuildingDef(p.building)).toBeDefined();
  });
});

describe('grid', () => {
  it('round-trips parcel ids and covers chunks without overlap', () => {
    for (const [lng, lat] of [[2.45, 46.63], [-122.4, 37.77], [139.7, 35.68], [-58.4, -34.6], [179.999, 0.0005]]) {
      const id = parcelIdAt(lng, lat);
      const b = parcelBounds(id);
      expect(lng).toBeGreaterThanOrEqual(b.west);
      expect(lng).toBeLessThan(b.east);
      expect(lat).toBeGreaterThanOrEqual(b.south);
      expect(lat).toBeLessThan(b.north);
      expect(parcelsInChunk(chunkOfParcel(id))).toContain(id);
    }
  });

  it('parcels are roughly 111 m square at mid latitudes', () => {
    const id = parcelIdAt(2.45, 46.63);
    const ring = parcelRing(id);
    const w = lngLatToMeters(ring[0], ring[1]).east;
    const h = lngLatToMeters(ring[0], ring[3]).north;
    expect(w).toBeGreaterThan(100);
    expect(w).toBeLessThan(125);
    expect(h).toBeCloseTo(111.3, 0);
  });

  it('footprints rotate clockwise and fit inside parcels', () => {
    const id = parcelIdAt(2.45, 46.63);
    const b = parcelBounds(id);
    const c: [number, number] = [(b.west + b.east) / 2, (b.south + b.north) / 2];
    const ring = footprintRing(c, 40, 10, 90);
    const m = ring.map((p) => lngLatToMeters(c, p));
    const maxNorth = Math.max(...m.map((p) => p.north));
    expect(maxNorth).toBeCloseTo(20, 0); // width now runs north-south
    expect(ringWithin(ring, parcelRing(id))).toBe(true);
  });

  it('levels', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(899)).toBe(3);
  });
});
