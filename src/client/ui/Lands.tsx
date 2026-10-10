'use client';

import { useState } from 'react';
import { game, teleport } from '../game';
import { LAND_CLASSES } from '@/shared/config/land';
import { Badge, Credits, Empty, ErrorBox, Loading, useApi } from './common';

export interface OwnedParcel { id: string; name: string | null; lng: number; lat: number; landClass: string; buildings: number; listingPrice: number | null }

/** All of the player's land, each with an instant teleport. */
export function MyLandList({ onTeleport }: { onTeleport?: () => void }) {
  const me = game.use((s) => s.me);
  const { data, error, loading, reload } = useApi<{ parcels: OwnedParcel[] }>('/api/parcels/mine', ['wallet', 'listings', 'selection']);
  const settlement = useApi<{ lng: number; lat: number; name: string }>(me?.settlement ? `/api/settlements/${me.settlement.id}` : null, ['settlement']);
  const go = (lng: number, lat: number, id?: string) => {
    teleport(lng, lat, 17.5);
    if (id) game.set({ selection: { kind: 'parcel', id }, panel: 'world' });
    onTeleport?.();
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  return (
    <ul className="space-y-1" data-testid="my-lands">
      {data?.parcels.length === 0 && <li><Empty>You do not own land yet.</Empty></li>}
      {data?.parcels.map((p) => (
        <li key={p.id}>
          <button onClick={() => go(p.lng, p.lat, p.id)} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-ink-800" data-testid={`teleport-${p.id}`}>
            <span className="min-w-0 truncate">
              <span className="text-fog-100">{p.name ?? `Parcel #${p.id}`}</span>
              <span className="ml-2 text-xs text-fog-400">{LAND_CLASSES[p.landClass as keyof typeof LAND_CLASSES]?.name} · {p.buildings} bldg</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {p.listingPrice !== null && <Badge tone="warn">for sale</Badge>}
              <span className="text-xs text-accent">Teleport ↗</span>
            </span>
          </button>
        </li>
      ))}
      {settlement.data && (
        <li>
          <button onClick={() => go(settlement.data!.lng, settlement.data!.lat)} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-ink-800">
            <span>{settlement.data.name} <span className="text-xs text-fog-400">settlement</span></span>
            <span className="text-xs text-violet">Teleport ↗</span>
          </button>
        </li>
      )}
    </ul>
  );
}

/** Top-bar teleport menu. */
export function TeleportMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="rounded-md px-2 py-1 text-xs text-fog-300 hover:bg-ink-800 hover:text-fog-100" data-testid="teleport-menu">
        Teleport ▾
      </button>
      {open && (
        <div className="panel scroll-thin absolute right-0 top-9 z-50 max-h-[60vh] w-80 overflow-y-auto rounded-xl p-2" role="dialog" aria-label="Teleport to your land">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fog-400">Teleport to your land</p>
          <MyLandList onTeleport={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

interface Listing { parcelId: string; name: string | null; price: number; seller: string; sellerId: string; landClass: string; lng: number; lat: number; buildings: number }

/** Player land market: every parcel currently listed for sale. */
export function LandForSale() {
  const me = game.use((s) => s.me);
  const { data, error, loading, reload } = useApi<{ listings: Listing[] }>('/api/listings', ['listings']);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data?.listings.length) return <Empty>No land is listed for sale right now.</Empty>;
  return (
    <ul className="space-y-1" data-testid="land-for-sale">
      {data.listings.map((l) => (
        <li key={l.parcelId}>
          <button onClick={() => { teleport(l.lng, l.lat, 17.5); game.set({ selection: { kind: 'parcel', id: l.parcelId }, panel: 'world' }); }} className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-ink-800">
            <span className="min-w-0 truncate">
              {l.name ?? `#${l.parcelId}`}
              <span className="ml-2 text-xs text-fog-400">{l.sellerId === me?.id ? 'yours' : l.seller} · {l.buildings} bldg</span>
            </span>
            <Credits value={l.price} className="shrink-0 text-xs text-warn" />
          </button>
        </li>
      ))}
    </ul>
  );
}
