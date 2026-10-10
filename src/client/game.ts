// Client game state: authoritative data fetched from the server, updated by realtime events.
import { apiGet } from './api';
import { createStore } from './store';
import type { BuildingSummary, Chunk, Me, Panel, ParcelOwner, Placement, Selection } from './types';
import { MAX_CHUNKS_PER_REQUEST } from '@/shared/grid';

export interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string }

export interface GameState {
  me: Me | null;
  meError: string | null;
  panel: Panel;
  selection: Selection;
  placement: Placement | null;
  chunks: Map<string, Chunk>;
  chunkVersion: number;
  loadingChunks: number;
  chunkError: string | null;
  connection: 'connecting' | 'online' | 'offline';
  online: number;
  presence: Record<string, { id: string; name: string }[]>;
  view: { lng: number; lat: number; zoom: number; bearing: number; pitch: number };
  toasts: Toast[];
  mapStatus: 'loading' | 'ready' | 'fallback';
  /** Bumped when server-side data relevant to open panels changed (wallet, inventory, settlements...). */
  dataVersion: Record<string, number>;
  flyTo: { lng: number; lat: number; zoom?: number; instant?: boolean; seq: number } | null;
}

export const game = createStore<GameState>({
  me: null,
  meError: null,
  panel: 'world',
  selection: null,
  placement: null,
  chunks: new Map(),
  chunkVersion: 0,
  loadingChunks: 0,
  chunkError: null,
  connection: 'connecting',
  online: 0,
  presence: {},
  view: { lng: 0, lat: 20, zoom: 1.6, bearing: 0, pitch: 0 },
  toasts: [],
  mapStatus: 'loading',
  dataVersion: {},
  flyTo: null,
});

let toastSeq = 0;
export function toast(kind: Toast['kind'], text: string) {
  const id = ++toastSeq;
  game.set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
  setTimeout(() => game.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 4000);
}

export function bump(...keys: string[]) {
  game.set((s) => {
    const dv = { ...s.dataVersion };
    for (const k of keys) dv[k] = (dv[k] ?? 0) + 1;
    return { dataVersion: dv };
  });
}

export function flyTo(lng: number, lat: number, zoom?: number, instant = false) {
  game.set((s) => ({ flyTo: { lng, lat, zoom, instant, seq: (s.flyTo?.seq ?? 0) + 1 } }));
}

/** Instantly moves the camera to a location (no flight animation). */
export function teleport(lng: number, lat: number, zoom = 17) {
  flyTo(lng, lat, zoom, true);
}

export async function refreshMe() {
  try {
    const me = await apiGet<Me>('/api/me');
    game.set({ me, meError: null });
  } catch (err) {
    game.set({ meError: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Chunk cache (viewport streaming)
// ---------------------------------------------------------------------------

const MAX_CACHED_CHUNKS = 240;
const inflight = new Set<string>();
const lastUsed = new Map<string, number>();

export async function ensureChunks(keys: string[], force = false) {
  const now = Date.now();
  for (const k of keys) lastUsed.set(k, now);
  const { chunks } = game.get();
  const missing = keys.filter((k) => (force || !chunks.has(k)) && !inflight.has(k));
  for (let i = 0; i < missing.length; i += MAX_CHUNKS_PER_REQUEST) {
    const batch = missing.slice(i, i + MAX_CHUNKS_PER_REQUEST);
    batch.forEach((k) => inflight.add(k));
    game.set((s) => ({ loadingChunks: s.loadingChunks + 1 }));
    try {
      const data = await apiGet<{ chunks: Chunk[] }>(`/api/world/chunks?keys=${batch.join(',')}`);
      game.set((s) => {
        const next = new Map(s.chunks);
        for (const c of data.chunks) next.set(c.key, c);
        evict(next);
        return { chunks: next, chunkVersion: s.chunkVersion + 1, chunkError: null };
      });
    } catch (err) {
      game.set({ chunkError: (err as Error).message });
    } finally {
      batch.forEach((k) => inflight.delete(k));
      game.set((s) => ({ loadingChunks: s.loadingChunks - 1 }));
    }
  }
}

function evict(map: Map<string, Chunk>) {
  if (map.size <= MAX_CACHED_CHUNKS) return;
  const byAge = [...map.keys()].sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
  for (const k of byAge.slice(0, map.size - MAX_CACHED_CHUNKS)) map.delete(k);
}

/** Re-fetches every cached chunk (used after a realtime gap that cannot be replayed). */
export async function reloadAllChunks() {
  await ensureChunks([...game.get().chunks.keys()], true);
}

function updateChunk(key: string, fn: (c: Chunk) => Chunk) {
  game.set((s) => {
    const c = s.chunks.get(key);
    if (!c) return {};
    const next = new Map(s.chunks);
    next.set(key, fn(c));
    return { chunks: next, chunkVersion: s.chunkVersion + 1 };
  });
}

export function applyParcelEvent(chunkKey: string, p: ParcelOwner) {
  updateChunk(chunkKey, (c) => {
    const parcels = c.parcels.filter((x) => x.id !== p.id);
    if (p.ownerId || p.settlementId) parcels.push(p);
    return { ...c, parcels };
  });
}

export function applyBuildingEvent(chunkKey: string, b: BuildingSummary) {
  updateChunk(chunkKey, (c) => ({ ...c, buildings: [...c.buildings.filter((x) => x.id !== b.id), b] }));
}

export function applyBuildingRemoved(chunkKey: string, id: string) {
  updateChunk(chunkKey, (c) => ({ ...c, buildings: c.buildings.filter((x) => x.id !== id) }));
  const sel = game.get().selection;
  if (sel?.kind === 'building' && sel.id === id) game.set({ selection: null });
}

export function findBuilding(id: string): BuildingSummary | undefined {
  for (const c of game.get().chunks.values()) {
    const b = c.buildings.find((x) => x.id === id);
    if (b) return b;
  }
  return undefined;
}

if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as unknown as { __worldstate: typeof game }).__worldstate = game;
}
