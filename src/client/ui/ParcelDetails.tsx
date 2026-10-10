'use client';

import { useState } from 'react';
import { flyTo, game } from '../game';
import { grantPermission, purchaseParcel } from '../actions';
import { getBuildingDef } from '@/shared/config/buildings';
import type { BuildingSummary } from '../types';
import { Badge, Button, Credits, ErrorBox, Input, Loading, Row, Section, timeAgo, useApi } from './common';

interface ParcelInfo {
  id: string; center: [number, number]; landClass: string; landClassName: string; landClassDescription: string; status: string;
  ownerId: string | null; ownerName: string | null; settlementId: string | null; settlementName: string | null;
  price: number | null; lastPrice: number | null; buildings: BuildingSummary[];
  history: { reason: string; price: number; at: string; from: string | null; to: string | null; toSettlement: string | null }[];
  builders: { id: string; name: string }[]; canBuild: boolean;
}

export default function ParcelDetails({ id }: { id: string }) {
  const me = game.use((s) => s.me)!;
  const { data, error, loading, reload } = useApi<ParcelInfo>(`/api/parcels/${id}`, ['selection']);
  const [grantee, setGrantee] = useState('');

  if (loading && !data) return <Section title={`Parcel #${id}`}><Loading /></Section>;
  if (error) return <Section title={`Parcel #${id}`}><ErrorBox message={error} onRetry={reload} /></Section>;
  if (!data) return null;
  const p = data;
  const tone = p.status === 'available' ? 'accent' : p.status === 'mine' ? 'accent' : p.status === 'settlement' ? 'violet' : p.status === 'restricted' || p.status === 'water' ? 'danger' : 'neutral';
  const label = { available: 'Available', mine: 'Owned by you', owned: `Owned by ${p.ownerName}`, settlement: `Settlement: ${p.settlementName}`, water: 'Water', restricted: 'Restricted' }[p.status] ?? p.status;
  const atCap = me.parcelCount >= me.maxParcels;
  const cantAfford = p.price !== null && me.balance < p.price;
  const purchaseBlock = p.status !== 'available' ? null : atCap ? `Level ${me.level} limit reached (${me.maxParcels} parcels). Level up to buy more.` : cantAfford ? 'Not enough credits.' : null;
  const canBuildHere = p.status === 'mine' || p.canBuild || (p.status === 'settlement' && p.settlementId === me.settlement?.id);

  return (
    <>
      <Section title={`Parcel #${p.id}`} actions={<Badge tone={tone}>{label}</Badge>}>
        <Row label="Land class">{p.landClassName}</Row>
        <p className="mb-2 text-xs text-fog-400">{p.landClassDescription}</p>
        <Row label="Centre"><span className="font-mono text-xs">{p.center[1].toFixed(5)}, {p.center[0].toFixed(5)}</span></Row>
        {p.price !== null && <Row label="Price"><Credits value={p.price} /></Row>}
        {p.lastPrice !== null && <Row label="Last sale"><Credits value={p.lastPrice} /></Row>}
        {p.status === 'available' && (
          <div className="mt-3 space-y-1">
            <Button variant="primary" className="w-full" disabled={!!purchaseBlock} data-testid="buy-parcel" onClick={async () => { await purchaseParcel(p.id, p.price); reload(); }}>
              Buy parcel {p.price !== null && <>for <Credits value={p.price} /></>}
            </Button>
            {purchaseBlock && <p className="text-xs text-fog-400">{purchaseBlock}</p>}
            <p className="text-[11px] text-fog-400">Virtual land only. Price is set by the server from land class and local demand.</p>
          </div>
        )}
        {canBuildHere && (
          <Button variant="secondary" className="mt-3 w-full" onClick={() => { flyTo(p.center[0], p.center[1], 17.5); game.set({ panel: 'build' }); }} data-testid="build-here">
            Build on this parcel
          </Button>
        )}
      </Section>
      {p.buildings.length > 0 && (
        <Section title="Structures">
          <ul className="space-y-1">
            {p.buildings.map((b) => (
              <li key={b.id}>
                <button className="flex w-full justify-between rounded-md px-2 py-1.5 text-sm hover:bg-ink-800" onClick={() => game.set({ selection: { kind: 'building', id: b.id } })}>
                  <span>{getBuildingDef(b.type)?.name ?? b.type}</span><span className="text-xs text-fog-400">Lv {b.level} · {b.ownerName ?? 'Settlement'}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {p.status === 'mine' && (
        <Section title="Build permissions">
          {p.builders.length === 0 && <p className="mb-2 text-xs text-fog-400">Only you can build here.</p>}
          {p.builders.map((b) => (
            <div key={b.id} className="flex items-center justify-between py-1 text-sm">
              <span>{b.name}</span>
              <Button variant="ghost" onClick={async () => { await grantPermission(p.id, b.name, false); reload(); }}>Revoke</Button>
            </div>
          ))}
          <form className="mt-2 flex items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (!/^[A-Za-z0-9_]{3,24}$/.test(grantee)) return; if (await grantPermission(p.id, grantee, true)) { setGrantee(''); reload(); } }}>
            <div className="flex-1"><Input label="Allow player (username)" value={grantee} onChange={(e) => setGrantee(e.target.value)} error={grantee && !/^[A-Za-z0-9_]{3,24}$/.test(grantee) ? 'Invalid username' : null} /></div>
            <Button type="submit" disabled={!grantee}>Grant</Button>
          </form>
        </Section>
      )}
      {p.history.length > 0 && (
        <Section title="Ownership history">
          <ul className="space-y-1 text-xs text-fog-300">
            {p.history.map((h, i) => (
              <li key={i} className="flex justify-between">
                <span>{h.reason.replace(/_/g, ' ')} → {h.to ?? h.toSettlement ?? '—'}</span>
                <span className="text-fog-400">{h.price > 0 && <Credits value={h.price} />} {timeAgo(h.at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
