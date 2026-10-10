// User actions: each calls the authoritative API and reports the real outcome.
import { apiPost } from './api';
import { applyBuildingEvent, applyParcelEvent, bump, game, refreshMe, toast } from './game';
import type { BuildingSummary } from './types';
import { chunkKeyAt, chunkOfParcel } from '@/shared/grid';
import { formatCredits } from '@/shared/config/resources';
import { getBuildingDef } from '@/shared/config/buildings';

export async function run<T>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | null> {
  try {
    const r = await fn();
    if (success) toast('success', typeof success === 'function' ? success(r) : success);
    return r;
  } catch (err) {
    toast('error', (err as Error).message);
    return null;
  }
}

export async function purchaseParcel(parcelId: string, quotedPrice: number | null) {
  const r = await run(
    () => apiPost<{ parcelId: string; price: number }>(`/api/parcels/${parcelId}/purchase`, quotedPrice ? { maxPrice: quotedPrice } : {}),
    (x) => `Parcel purchased for ${formatCredits(x.price)}`,
  );
  if (r) {
    const me = game.get().me;
    if (me) applyParcelEvent(chunkOfParcel(parcelId), { id: parcelId, ownerId: me.id, ownerName: me.displayName, settlementId: null, settlementName: null });
    await refreshMe();
    bump('selection', 'wallet');
  }
  return r;
}

export async function placeBuilding(type: string, parcelId: string, lngLat: [number, number], rotation: number) {
  const def = getBuildingDef(type);
  const r = await run(
    () => apiPost<{ building: BuildingSummary; cost: number }>('/api/buildings', { type, parcelId, lng: lngLat[0], lat: lngLat[1], rotation }),
    (x) => `${def?.name ?? 'Building'} constructed for ${formatCredits(x.cost)}`,
  );
  if (r) {
    applyBuildingEvent(chunkKeyAt(r.building.lng, r.building.lat), r.building);
    await refreshMe();
    bump('inventory', 'wallet');
  }
  return r;
}

export async function upgradeBuilding(id: string) {
  const r = await run(() => apiPost<{ building: BuildingSummary; cost: number }>(`/api/buildings/${id}/upgrade`), (x) => `Upgraded to level ${x.building.level}`);
  if (r) { applyBuildingEvent(chunkKeyAt(r.building.lng, r.building.lat), r.building); bump('selection', 'inventory'); await refreshMe(); }
  return r;
}

export async function demolishBuilding(id: string) {
  const r = await run(() => apiPost<{ id: string; refund: number }>(`/api/buildings/${id}/demolish`), (x) => `Demolished. Refunded ${formatCredits(x.refund)}`);
  if (r) { game.set({ selection: null }); bump('selection'); await refreshMe(); }
  return r;
}

export async function startProduction(id: string, recipeId: string, autoRepeat: boolean) {
  const r = await run(() => apiPost<{ runId: string; completesAt: string }>(`/api/buildings/${id}/production`, { recipeId, autoRepeat }), 'Production started');
  if (r) bump('selection', 'inventory', 'production');
  return r;
}

export async function cancelProduction(id: string) {
  const r = await run(() => apiPost(`/api/buildings/${id}/production/cancel`), 'Production cancelled; inputs returned');
  if (r) bump('selection', 'inventory', 'production');
  return r;
}

export async function setAutoRepeat(id: string, autoRepeat: boolean) {
  const r = await run(() => apiPost(`/api/buildings/${id}/auto-repeat`, { autoRepeat }), autoRepeat ? 'Automatic production enabled' : 'Automatic production disabled');
  if (r) bump('selection', 'production');
  return r;
}

export async function grantPermission(parcelId: string, username: string, grant: boolean) {
  const r = await run(() => apiPost(`/api/parcels/${parcelId}/permissions`, { username, grant }), grant ? `${username} may now build here` : `Permission revoked for ${username}`);
  if (r) bump('selection');
  return r;
}
