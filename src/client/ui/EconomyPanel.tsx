'use client';

import { useEffect, useState } from 'react';
import { apiPost } from '../api';
import { bump, flyTo, game, refreshMe } from '../game';
import { run } from '../actions';
import { realtime } from '../realtime';
import { getBuildingDef } from '@/shared/config/buildings';
import { getRecipe } from '@/shared/config/recipes';
import { RESOURCES, RESOURCE_IDS, formatCredits, type ResourceId } from '@/shared/config/resources';
import type { Inventory } from '../types';
import { Badge, Button, Credits, Empty, ErrorBox, Input, Loading, Section, Select, parseCredits, timeAgo, useApi, useNow } from './common';

interface EconomyData {
  balance: number;
  inventory: Inventory;
  businesses: { id: string; type: string; level: number; status: string; autoRepeat: boolean; lng: number; lat: number; runRecipeId: string | null; completesAt: string | null }[];
  runs: { id: string; recipeId: string; status: string; outputs: Record<string, number>; currencyOut: number; startedAt: string }[];
  ledger: { id: number; type: string; amount: number; at: string; incoming: boolean }[];
}

function Overview() {
  const { data, error, loading, reload } = useApi<EconomyData>('/api/economy', ['wallet', 'inventory', 'production']);
  const now = useNow();
  if (loading && !data) return <Section title="Wallet"><Loading /></Section>;
  if (error) return <Section title="Wallet"><ErrorBox message={error} onRetry={reload} /></Section>;
  if (!data) return null;
  return (
    <>
      <Section title="Wallet">
        <p className="text-2xl font-semibold" data-testid="wallet-balance"><Credits value={data.balance} /></p>
        <p className="text-xs text-fog-400">Balances change only through recorded ledger transactions.</p>
      </Section>
      <Section title={`Inventory · capacity ${data.inventory.capacity} each`}>
        <ul className="space-y-2">
          {RESOURCE_IDS.map((r) => {
            const q = data.inventory.items[r];
            const pct = Math.min(100, (q / data.inventory.capacity) * 100);
            return (
              <li key={r} data-testid={`inv-${r}`}>
                <div className="flex justify-between text-sm"><span>{RESOURCES[r].name}</span><span className="font-mono tabular-nums">{q}</span></div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-ink-700"><div className="h-full" style={{ width: `${pct}%`, background: RESOURCES[r].color }} /></div>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title="Businesses">
        {data.businesses.length === 0 && <Empty>No production buildings yet. Build a lumber camp, quarry, farm or shop.</Empty>}
        <ul className="space-y-1">
          {data.businesses.map((b) => {
            const left = b.completesAt ? Math.max(0, Math.ceil((new Date(b.completesAt).getTime() - now) / 1000)) : 0;
            return (
              <li key={b.id}>
                <button className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-ink-800" onClick={() => { flyTo(b.lng, b.lat, 17.5); game.set({ panel: 'world', selection: { kind: 'building', id: b.id } }); }}>
                  <span>{getBuildingDef(b.type)?.name} <span className="text-xs text-fog-400">Lv {b.level}</span></span>
                  <span className="flex items-center gap-2 text-xs">
                    {b.status === 'producing' ? <Badge tone="warn">{getRecipe(b.runRecipeId ?? '')?.name} · {left}s</Badge> : <Badge>idle</Badge>}
                    {b.autoRepeat && <Badge tone="accent">auto</Badge>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title="Recent production">
        {data.runs.length === 0 && <Empty>No production runs yet.</Empty>}
        <ul className="space-y-1 text-xs text-fog-300">
          {data.runs.slice(0, 10).map((r) => (
            <li key={r.id} className="flex justify-between">
              <span>{getRecipe(r.recipeId)?.name} <span className="text-fog-400">({r.status})</span></span>
              <span className="text-fog-400">{timeAgo(r.startedAt)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

interface Book {
  resource: string; feeBps: number;
  bids: { id: string; pricePerUnit: number; remaining: number; trader: string; mine: boolean }[];
  asks: { id: string; pricePerUnit: number; remaining: number; trader: string; mine: boolean }[];
  trades: { id: string; quantity: number; pricePerUnit: number; at: string }[];
  myOrders: { id: string; side: string; resource: string; pricePerUnit: number; quantity: number; remaining: number; status: string; expiresAt: string }[];
}

function Market() {
  const [resource, setResource] = useState<ResourceId>('wood');
  const summary = useApi<{ resources: { resource: string; bestBid: number | null; bestAsk: number | null; lastPrice: number | null; volume24h: number }[] }>('/api/market', ['market']);
  const book = useApi<Book>(`/api/market/${resource}`, ['market', 'inventory', 'wallet']);
  const [side, setSide] = useState<'buy' | 'sell'>('sell');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [hours, setHours] = useState('24');
  const [takeQty, setTakeQty] = useState<Record<string, string>>({});

  useEffect(() => {
    realtime.setChannel('market', resource);
    return () => realtime.setChannel('market', null);
  }, [resource]);

  const priceMinor = parseCredits(price);
  const qtyN = /^\d+$/.test(qty) ? Number(qty) : null;
  const formError = price && !priceMinor ? 'Enter a price like 12.50' : qty && (!qtyN || qtyN <= 0) ? 'Enter a whole quantity' : null;

  async function place() {
    if (!priceMinor || !qtyN) return;
    const r = await run(
      () => apiPost<{ trades: unknown[]; order: { status: string } }>('/api/market/orders', { side, resource, pricePerUnit: priceMinor, quantity: qtyN, expiresHours: Number(hours) }),
      (x) => (x.trades.length ? `Order placed and matched ${x.trades.length} trade(s)` : 'Order placed on the book'),
    );
    if (r) { setPrice(''); setQty(''); bump('market', 'inventory', 'wallet'); refreshMe(); }
  }

  return (
    <>
      <Section title="Prices">
        {summary.loading && !summary.data && <Loading />}
        {summary.error && <ErrorBox message={summary.error} onRetry={summary.reload} />}
        {summary.data && (
          <table className="w-full text-xs">
            <thead className="text-fog-400"><tr><th className="py-1 text-left font-normal">Resource</th><th className="text-right font-normal">Bid</th><th className="text-right font-normal">Ask</th><th className="text-right font-normal">Last</th><th className="text-right font-normal">24h vol</th></tr></thead>
            <tbody>
              {summary.data.resources.map((r) => (
                <tr key={r.resource} className={`cursor-pointer hover:bg-ink-800 ${r.resource === resource ? 'text-accent' : ''}`} onClick={() => setResource(r.resource as ResourceId)}>
                  <td className="py-1">{RESOURCES[r.resource as ResourceId].name}</td>
                  <td className="text-right font-mono">{r.bestBid ? formatCredits(r.bestBid) : '–'}</td>
                  <td className="text-right font-mono">{r.bestAsk ? formatCredits(r.bestAsk) : '–'}</td>
                  <td className="text-right font-mono">{r.lastPrice ? formatCredits(r.lastPrice) : '–'}</td>
                  <td className="text-right font-mono">{r.volume24h}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section title={`Order book · ${RESOURCES[resource].name}`}>
        <Select label="Resource" value={resource} onChange={(e) => setResource(e.target.value as ResourceId)}>
          {RESOURCE_IDS.map((r) => <option key={r} value={r}>{RESOURCES[r].name}</option>)}
        </Select>
        {book.error && <div className="mt-2"><ErrorBox message={book.error} onRetry={book.reload} /></div>}
        {book.loading && !book.data && <div className="mt-2"><Loading /></div>}
        {book.data && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            {(['asks', 'bids'] as const).map((k) => (
              <div key={k}>
                <p className="mb-1 font-medium text-fog-300">{k === 'asks' ? 'Selling (asks)' : 'Buying (bids)'}</p>
                {book.data![k].length === 0 && <p className="text-fog-400">No orders.</p>}
                <ul className="space-y-1">
                  {book.data![k].map((o) => (
                    <li key={o.id} className="rounded border border-ink-700 p-1.5">
                      <div className="flex justify-between"><span className="font-mono">{formatCredits(o.pricePerUnit)}</span><span>× {o.remaining}</span></div>
                      <div className="text-[10px] text-fog-400">{o.mine ? 'your order' : o.trader}</div>
                      {!o.mine && (
                        <div className="mt-1 flex gap-1">
                          <input aria-label="Quantity to trade" className="w-14 rounded border border-ink-600 bg-ink-850 px-1 text-xs" value={takeQty[o.id] ?? ''} placeholder={String(o.remaining)} onChange={(e) => setTakeQty({ ...takeQty, [o.id]: e.target.value })} />
                          <Button variant="secondary" className="px-2 py-0.5 text-xs" onClick={async () => {
                            const q = Number(takeQty[o.id] || o.remaining);
                            if (!Number.isInteger(q) || q <= 0) return;
                            const r = await run(() => apiPost(`/api/market/orders/${o.id}/take`, { quantity: q }), k === 'asks' ? `Bought ${q} ${resource}` : `Sold ${q} ${resource}`);
                            if (r) { bump('market', 'inventory', 'wallet'); refreshMe(); }
                          }}>{k === 'asks' ? 'Buy' : 'Sell'}</Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="New order">
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); place(); }} data-testid="order-form">
          <div className="flex gap-1" role="radiogroup" aria-label="Side">
            {(['sell', 'buy'] as const).map((s) => (
              <button type="button" key={s} role="radio" aria-checked={side === s} onClick={() => setSide(s)} className={`flex-1 rounded-md px-2 py-1.5 text-sm ${side === s ? 'bg-ink-700 text-fog-100' : 'text-fog-400'}`}>{s === 'sell' ? 'Sell' : 'Buy'}</button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Input label="Price / unit (CR)" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
            <Input label="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" />
            <Select label="Expires" value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option>
            </Select>
          </div>
          {formError && <p className="text-xs text-danger">{formError}</p>}
          {priceMinor && qtyN ? <p className="text-xs text-fog-400">Total {formatCredits(priceMinor * qtyN)} · {side === 'sell' ? `fee ${(book.data?.feeBps ?? 200) / 100}% on sale; goods are escrowed` : 'credits are escrowed until filled or cancelled'}</p> : null}
          <Button type="submit" variant="primary" disabled={!priceMinor || !qtyN}>Place {side} order</Button>
        </form>
      </Section>
      <Section title="My orders">
        {book.data && book.data.myOrders.length === 0 && <Empty>No orders yet.</Empty>}
        <ul className="space-y-1 text-xs">
          {book.data?.myOrders.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-2 rounded border border-ink-700 px-2 py-1.5">
              <span>{o.side} {o.quantity - o.remaining}/{o.quantity} {o.resource} @ {formatCredits(o.pricePerUnit)}</span>
              {o.status === 'open' ? (
                <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={async () => { const r = await run(() => apiPost(`/api/market/orders/${o.id}/cancel`), 'Order cancelled; escrow returned'); if (r) { bump('market', 'inventory', 'wallet'); refreshMe(); } }}>Cancel</Button>
              ) : <Badge>{o.status}</Badge>}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Ledger() {
  const { data, error, loading, reload } = useApi<EconomyData>('/api/economy', ['wallet']);
  return (
    <Section title="Transaction history">
      {loading && !data && <Loading />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data && data.ledger.length === 0 && <Empty>No transactions.</Empty>}
      <ul className="space-y-1 text-xs" data-testid="ledger">
        {data?.ledger.map((l) => (
          <li key={l.id} className="flex justify-between">
            <span className="text-fog-300">{l.type.replace(/_/g, ' ')} <span className="text-fog-400">{timeAgo(l.at)}</span></span>
            <span className={`font-mono ${l.incoming ? 'text-accent' : 'text-fog-200'}`}>{l.incoming ? '+' : '−'}{formatCredits(l.amount)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default function EconomyPanel() {
  const [tab, setTab] = useState<'overview' | 'market' | 'ledger'>('overview');
  return (
    <div>
      <div className="sticky top-0 z-10 flex gap-1 border-b border-ink-700 bg-ink-900 p-2" role="tablist">
        {(['overview', 'market', 'ledger'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`economy-tab-${t}`} className={`flex-1 rounded-md px-2 py-1.5 text-sm capitalize ${tab === t ? 'bg-ink-700 text-fog-100' : 'text-fog-400 hover:text-fog-200'}`}>{t}</button>
        ))}
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'market' && <Market />}
      {tab === 'ledger' && <Ledger />}
    </div>
  );
}
