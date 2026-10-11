'use client';

import { useState } from 'react';
import { flyTo, game } from '../game';
import { BUILDINGS, CATEGORY_COLORS, CATEGORY_LABELS, type BuildingCategory, type BuildingDef } from '@/shared/config/buildings';
import { LAND_CLASSES } from '@/shared/config/land';
import { RESOURCES, type ResourceId } from '@/shared/config/resources';
import { getTech } from '@/shared/config/research';
import type { Inventory, Me } from '../types';
import { Badge, Button, Credits, Empty, ErrorBox, Loading, Section, useApi } from './common';

function lockReason(def: BuildingDef, me: Me, inv: Inventory | null, owned: Record<string, number>): string | null {
  const r = def.requirements;
  if (r.minLevel && me.level < r.minLevel) return `Requires level ${r.minLevel}`;
  const missing = (r.research ?? []).filter((t) => !me.techs.includes(t));
  if (missing.length) return `Research ${missing.map((t) => getTech(t)?.name ?? t).join(', ')}`;
  const need = (r.requiresOwned ?? []).filter((t) => !owned[t]);
  if (need.length) return `Own a ${need.map((t) => BUILDINGS.find((b) => b.type === t)?.name ?? t).join(', ')} first`;
  if (me.balance < Math.round(def.cost * me.modifiers.buildCostMultiplier)) return 'Not enough credits';
  if (inv) for (const [res, q] of Object.entries(def.resources)) if ((inv.items[res as ResourceId] ?? 0) < (q ?? 0)) return `Need ${q} ${RESOURCES[res as ResourceId].name.toLowerCase()}`;
  return null;
}

export default function BuildPanel() {
  const me = game.use((s) => s.me)!;
  const placement = game.use((s) => s.placement);
  const zoom = game.use((s) => s.view.zoom);
  const [cat, setCat] = useState<BuildingCategory | 'all'>('all');
  const inv = useApi<{ inventory: Inventory }>('/api/inventory', ['inventory']);
  const mine = useApi<{ buildings: { type: string }[] }>('/api/buildings/mine', ['inventory']);
  const parcels = useApi<{ parcels: { id: string; name: string | null; lng: number; lat: number; landClass: string; buildings: number }[] }>('/api/parcels/mine', ['wallet']);
  const owned: Record<string, number> = {};
  for (const b of mine.data?.buildings ?? []) owned[b.type] = (owned[b.type] ?? 0) + 1;

  const list = BUILDINGS.filter((b) => cat === 'all' || b.category === cat);
  return (
    <div>
      <Section title="My parcels">
        {parcels.loading && <Loading />}
        {parcels.error && <ErrorBox message={parcels.error} onRetry={parcels.reload} />}
        {parcels.data && parcels.data.parcels.length === 0 && <Empty>You do not own land yet. Select an available parcel on the map and buy it.</Empty>}
        <ul className="space-y-1">
          {parcels.data?.parcels.map((p) => (
            <li key={p.id}>
              <button onClick={() => { flyTo(p.lng, p.lat, 17.5); game.set({ selection: { kind: 'parcel', id: p.id } }); }} className="flex w-full justify-between rounded-md px-2 py-1.5 text-sm hover:bg-ink-800" data-testid={`my-parcel-${p.id}`}>
                <span className="text-xs text-fog-200">{p.name ?? `#${p.id}`}</span>
                <span className="text-xs text-fog-400">{LAND_CLASSES[p.landClass as keyof typeof LAND_CLASSES]?.name} · {p.buildings} structures</span>
              </button>
            </li>
          ))}
        </ul>
        {zoom < 16 && parcels.data?.parcels.length ? <p className="mt-2 text-xs text-fog-400">Tip: zoom to street level over your parcel to place buildings precisely.</p> : null}
      </Section>
      <Section title="Catalog">
        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Building categories">
          {(['all', ...Object.keys(CATEGORY_LABELS)] as (BuildingCategory | 'all')[]).map((c) => (
            <button key={c} role="tab" aria-selected={cat === c} onClick={() => setCat(c)} className={`rounded-md px-2 py-1 text-xs ${cat === c ? 'bg-ink-700 text-fog-100' : 'text-fog-400 hover:text-fog-200'}`}>
              {c === 'all' ? 'All' : CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
        <ul className="space-y-2">
          {list.map((b) => {
            const reason = lockReason(b, me, inv.data?.inventory ?? null, owned);
            const active = placement?.type === b.type && !placement.projectFor;
            return (
              <li key={b.type} className={`rounded-lg border p-3 ${active ? 'border-accent' : 'border-ink-700'}`} data-testid={`catalog-${b.type}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: CATEGORY_COLORS[b.category] }} aria-hidden />{b.name}</p>
                    <p className="mt-0.5 text-xs text-fog-400">{b.description}</p>
                  </div>
                  <Badge>{b.width}×{b.depth} m</Badge>
                </div>
                <p className="mt-2 text-xs text-fog-300">
                  <Credits value={Math.round(b.cost * me.modifiers.buildCostMultiplier)} />
                  {Object.entries(b.resources).map(([r, q]) => <span key={r} className="ml-2">{q} {RESOURCES[r as ResourceId].name.toLowerCase()}</span>)}
                  {b.requirements.settlementLandOnly && <span className="ml-2 text-violet">settlement land only</span>}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant={active ? 'secondary' : 'primary'}
                    disabled={!!reason && !active}
                    data-testid={`place-${b.type}`}
                    onClick={() => game.set({ placement: active ? null : { type: b.type, rotation: 0, lngLat: null, parcelId: null, valid: false, reason: null } })}
                  >
                    {active ? 'Cancel placement' : 'Place'}
                  </Button>
                  {reason && !active && <span className="text-xs text-fog-400">{reason}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
