'use client';

import { useEffect, useState } from 'react';
import { flyTo, game, teleport } from '../game';
import { buyListedParcel, cancelParcelListing, grantPermission, listParcel, purchaseParcel, renameParcel, sellParcelToOffice } from '../actions';
import { getBuildingDef } from '@/shared/config/buildings';
import type { BuildingSummary } from '../types';
import { Badge, Button, Credits, ErrorBox, Input, Loading, Row, Section, parseCredits, timeAgo, useApi } from './common';

interface ParcelInfo {
  id: string; name: string | null; center: [number, number]; landClass: string; landClassName: string; landClassDescription: string; status: string;
  ownerId: string | null; ownerName: string | null; settlementId: string | null; settlementName: string | null;
  price: number | null; lastPrice: number | null; listingPrice: number | null; buildings: BuildingSummary[];
  quickSale: { land: number; buildings: number; total: number | null; blocked: string | null } | null;
  history: { reason: string; price: number; at: string; from: string | null; to: string | null; toSettlement: string | null }[];
  builders: { id: string; name: string }[]; canBuild: boolean;
}

const nameError = (n: string) => (n.trim().length === 0 ? 'Give your land a name' : n.trim().length > 40 ? 'At most 40 characters' : null);

export default function ParcelDetails({ id }: { id: string }) {
  const me = game.use((s) => s.me)!;
  const { data, error, loading, reload } = useApi<ParcelInfo>(`/api/parcels/${id}`, ['selection', 'listings']);
  const [grantee, setGrantee] = useState('');
  const [newName, setNewName] = useState('');
  const [rename, setRename] = useState('');
  const [askPrice, setAskPrice] = useState('');
  const [confirmSell, setConfirmSell] = useState(false);
  useEffect(() => { setNewName(''); setRename(''); setAskPrice(''); setConfirmSell(false); }, [id]);

  if (loading && !data) return <Section title={`Parcel #${id}`}><Loading /></Section>;
  if (error) return <Section title={`Parcel #${id}`}><ErrorBox message={error} onRetry={reload} /></Section>;
  if (!data) return null;
  const p = data;
  const forSale = p.status === 'owned' && p.listingPrice !== null;
  const tone = p.status === 'available' || p.status === 'mine' ? 'accent' : p.status === 'settlement' ? 'violet' : p.status === 'restricted' || p.status === 'water' ? 'danger' : forSale ? 'warn' : 'neutral';
  const label = { available: 'Available', mine: 'Owned by you', owned: forSale ? `For sale by ${p.ownerName}` : `Owned by ${p.ownerName}`, settlement: `Settlement: ${p.settlementName}`, water: 'Water', restricted: 'Restricted' }[p.status] ?? p.status;
  const atCap = me.parcelCount >= me.maxParcels;
  const capMsg = `Level ${me.level} limit reached (${me.maxParcels} parcels). Level up to own more.`;
  const purchaseBlock = p.status !== 'available' ? null : atCap ? capMsg : p.price !== null && me.balance < p.price ? 'Not enough credits.' : null;
  const listingBlock = !forSale ? null : atCap ? capMsg : me.balance < (p.listingPrice ?? 0) ? 'Not enough credits.' : null;
  const canBuildHere = p.status === 'mine' || p.canBuild || (p.status === 'settlement' && p.settlementId === me.settlement?.id);
  const askMinor = parseCredits(askPrice);

  return (
    <>
      <Section title={p.name ? `${p.name}` : `Parcel #${p.id}`} actions={<Badge tone={tone}>{label}</Badge>}>
        {p.name && <p className="mb-1 font-mono text-xs text-fog-400">#{p.id}</p>}
        <Row label="Land class">{p.landClassName}</Row>
        <p className="mb-2 text-xs text-fog-400">{p.landClassDescription}</p>
        <Row label="Centre"><span className="font-mono text-xs">{p.center[1].toFixed(5)}, {p.center[0].toFixed(5)}</span></Row>
        {p.price !== null && <Row label="Price"><Credits value={p.price} /></Row>}
        {p.listingPrice !== null && <Row label="Asking price"><Credits value={p.listingPrice} /></Row>}
        {p.lastPrice !== null && <Row label="Last sale"><Credits value={p.lastPrice} /></Row>}

        {p.status === 'available' && (
          <form className="mt-3 space-y-2" onSubmit={async (e) => { e.preventDefault(); if (!nameError(newName) && !purchaseBlock) { if (await purchaseParcel(p.id, p.price, newName.trim())) { setNewName(''); reload(); } } }}>
            <Input label="Name your land" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} placeholder="e.g. Riverside Farm" error={newName && nameError(newName)} data-testid="parcel-name" />
            <Button type="submit" variant="primary" className="w-full" disabled={!!purchaseBlock || !!nameError(newName)} data-testid="buy-parcel">
              Buy parcel {p.price !== null && <>for <Credits value={p.price} /></>}
            </Button>
            {purchaseBlock && <p className="text-xs text-fog-400">{purchaseBlock}</p>}
            <p className="text-[11px] text-fog-400">Virtual land only. Price is set by the server from land class and local demand.</p>
          </form>
        )}

        {forSale && p.ownerId !== me.id && (
          <form className="mt-3 space-y-2" onSubmit={async (e) => { e.preventDefault(); if (!nameError(newName) && !listingBlock) { if (await buyListedParcel(p.id, p.listingPrice!, newName.trim())) reload(); } }}>
            <Input label="Name your land" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} error={newName && nameError(newName)} />
            <Button type="submit" variant="primary" className="w-full" disabled={!!listingBlock || !!nameError(newName)} data-testid="buy-listing">
              Buy from {p.ownerName} for <Credits value={p.listingPrice!} />
            </Button>
            {listingBlock && <p className="text-xs text-fog-400">{listingBlock}</p>}
            {p.buildings.length > 0 && <p className="text-[11px] text-fog-400">Includes the seller&apos;s {p.buildings.length} building(s) on this land.</p>}
          </form>
        )}

        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={() => teleport(p.center[0], p.center[1], 17.5)} data-testid="teleport-parcel">Teleport here</Button>
          {canBuildHere && (
            <Button variant="secondary" onClick={() => { flyTo(p.center[0], p.center[1], 17.5); game.set({ panel: 'build' }); }} data-testid="build-here">Build here</Button>
          )}
        </div>
      </Section>

      {p.status === 'mine' && (
        <>
          <Section title="Name">
            <form className="flex items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (!nameError(rename)) { if (await renameParcel(p.id, rename.trim())) { setRename(''); reload(); } } }}>
              <div className="flex-1"><Input label="Rename this land" value={rename} onChange={(e) => setRename(e.target.value)} maxLength={40} placeholder={p.name ?? ''} error={rename && nameError(rename)} data-testid="rename-parcel" /></div>
              <Button type="submit" disabled={!rename.trim() || !!nameError(rename)}>Save</Button>
            </form>
          </Section>

          <Section title="Sell">
            <p className="mb-2 text-xs text-fog-400">Sell to another player at your price, or sell instantly to the land office.</p>
            {p.listingPrice !== null ? (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-warn/40 p-2 text-sm">
                <span>Listed for <Credits value={p.listingPrice} /></span>
                <Button variant="ghost" onClick={async () => { if (await cancelParcelListing(p.id)) reload(); }}>Remove listing</Button>
              </div>
            ) : null}
            <form className="mb-3 flex items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (askMinor && (await listParcel(p.id, askMinor))) { setAskPrice(''); reload(); } }}>
              <div className="flex-1"><Input label={p.listingPrice !== null ? 'Change asking price (CR)' : 'Asking price (CR)'} value={askPrice} onChange={(e) => setAskPrice(e.target.value)} inputMode="decimal" error={askPrice && !askMinor ? 'Enter a price like 2500' : null} data-testid="ask-price" /></div>
              <Button type="submit" disabled={!askMinor}>{p.listingPrice !== null ? 'Update' : 'List for sale'}</Button>
            </form>
            <p className="mb-2 text-[11px] text-fog-400">Buyers pay your asking price; a 2% fee is deducted. Your buildings on this land go to the buyer.</p>
            {p.quickSale?.total != null ? (
              confirmSell ? (
                <div className="space-y-2 rounded-lg border border-danger/40 p-2">
                  <p className="text-xs text-fog-200">
                    Sell “{p.name}” now for <Credits value={p.quickSale.total} />? {p.buildings.length > 0 && 'All your buildings on it will be removed.'} This cannot be undone.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="danger" data-testid="confirm-sell" onClick={async () => { if (await sellParcelToOffice(p.id)) { setConfirmSell(false); reload(); } }}>Sell now</Button>
                    <Button variant="ghost" onClick={() => setConfirmSell(false)}>Keep</Button>
                  </div>
                </div>
              ) : (
                <Button variant="danger" onClick={() => setConfirmSell(true)} data-testid="sell-to-office">
                  Sell to land office for <Credits value={p.quickSale.total} />
                </Button>
              )
            ) : (
              <p className="text-xs text-fog-400">Instant sale unavailable: {p.quickSale?.blocked}</p>
            )}
          </Section>
        </>
      )}

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
