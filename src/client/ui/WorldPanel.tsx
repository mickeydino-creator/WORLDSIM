'use client';

import { flyTo, game } from '../game';
import { LAND_CLASSES } from '@/shared/config/land';
import { PARCEL_MIN_ZOOM, chunkKeyAt, parcelCenter } from '@/shared/grid';
import { distanceMeters } from '@/shared/geo';
import ParcelDetails from './ParcelDetails';
import BuildingDetails from './BuildingDetails';
import { Badge, Empty, Section } from './common';

// Curated starting regions (any location on Earth can be reached by panning/zooming).
const REGIONS: { name: string; lng: number; lat: number }[] = [
  { name: 'Loire Valley, France', lng: 1.9093, lat: 47.3313 },
  { name: 'Jezreel Valley, Israel', lng: 35.29, lat: 32.62 },
  { name: 'Outer Tokyo, Japan', lng: 139.55, lat: 35.7 },
  { name: 'Fraser Valley, Canada', lng: -122.3, lat: 49.1 },
  { name: 'Pampas, Argentina', lng: -59.1, lat: -34.6 },
  { name: 'Western Cape, South Africa', lng: 18.85, lat: -33.9 },
  { name: 'Canterbury, New Zealand', lng: 172.3, lat: -43.55 },
];

function NearbyParcels() {
  const view = game.use((s) => s.view);
  const chunks = game.use((s) => s.chunks);
  const me = game.use((s) => s.me);
  if (view.zoom < PARCEL_MIN_ZOOM) return <Empty>Zoom in to street level to see individual parcels.</Empty>;
  const chunk = chunks.get(chunkKeyAt(view.lng, view.lat));
  if (!chunk) return <Empty>Loading parcels…</Empty>;
  const owners = new Map(chunk.parcels.map((p) => [p.id, p]));
  const list = Object.entries(chunk.cells)
    .map(([id, cls]) => ({ id, cls, owner: owners.get(id), d: distanceMeters([view.lng, view.lat], parcelCenter(id)) }))
    .filter((p) => p.cls !== 'water')
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  return (
    <ul className="space-y-1" data-testid="nearby-list">
      {list.map((p) => {
        const mine = p.owner?.ownerId === me?.id;
        const status = p.cls === 'restricted' ? 'Restricted' : p.owner?.settlementId ? p.owner.settlementName : p.owner ? (mine ? 'Yours' : p.owner.ownerName) : 'Available';
        return (
          <li key={p.id}>
            <button
              onClick={() => { game.set({ selection: { kind: 'parcel', id: p.id } }); const [lng, lat] = parcelCenter(p.id); flyTo(lng, lat); }}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-ink-800"
              data-testid={`parcel-${p.id}`}
            >
              <span className="font-mono text-xs text-fog-300">#{p.id}</span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-fog-400">{Math.round(p.d)} m · {LAND_CLASSES[p.cls].name}</span>
                <Badge tone={status === 'Available' ? 'accent' : mine ? 'accent' : p.owner?.settlementId ? 'violet' : p.cls === 'restricted' ? 'danger' : 'neutral'}>{status}</Badge>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function WorldPanel() {
  const selection = game.use((s) => s.selection);
  const view = game.use((s) => s.view);
  const presence = game.use((s) => s.presence[chunkKeyAt(s.view.lng, s.view.lat)] ?? []);
  const mapStatus = game.use((s) => s.mapStatus);
  const chunkError = game.use((s) => s.chunkError);
  const me = game.use((s) => s.me)!;

  return (
    <div>
      <Section title="Location">
        <p className="font-mono text-sm text-fog-200" data-testid="location">
          {view.lat.toFixed(4)}°, {view.lng.toFixed(4)}° <span className="text-fog-400">· zoom {view.zoom.toFixed(1)}</span>
        </p>
        <p className="mt-1 text-xs text-fog-400">WGS84 longitude/latitude. Parcels are ~111 m cells of a global grid.</p>
        {mapStatus === 'fallback' && <p className="mt-2 text-xs text-warn">Base map tiles are unavailable; showing the game layer only.</p>}
        {chunkError && <p className="mt-2 text-xs text-danger">{chunkError}</p>}
        {presence.length > 0 && (
          <p className="mt-2 text-xs text-fog-300">
            Here now: {presence.filter((p) => p.id !== me.id).map((p) => p.name).join(', ') || 'only you'}
          </p>
        )}
      </Section>
      {selection?.kind === 'parcel' && <ParcelDetails id={selection.id} />}
      {selection?.kind === 'building' && <BuildingDetails id={selection.id} />}
      {!selection && (
        <Section title="Getting started">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-fog-300">
            <li>Fly to a region and zoom to street level.</li>
            <li>Select an available parcel and buy it with credits.</li>
            <li>Open <b>Build</b>, pick a structure and place it on your land.</li>
          </ol>
        </Section>
      )}
      <Section title="Nearby parcels">
        <NearbyParcels />
      </Section>
      <Section title="Regions">
        <div className="grid grid-cols-1 gap-1">
          {me.home && (
            <button onClick={() => flyTo(me.home![0], me.home![1], 16.5)} className="rounded-md px-2 py-1.5 text-left text-sm text-accent hover:bg-ink-800">↩ My land</button>
          )}
          {REGIONS.map((r) => (
            <button key={r.name} onClick={() => flyTo(r.lng, r.lat, 16)} className="rounded-md px-2 py-1.5 text-left text-sm text-fog-200 hover:bg-ink-800" data-testid={`region-${r.name.split(',')[0].replace(/\s/g, '-')}`}>
              {r.name}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
