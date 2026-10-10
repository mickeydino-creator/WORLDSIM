// Realtime client: subscribes to visible chunks and personal/settlement channels, applies
// committed events from the server, and resynchronises after reconnecting.
import { applyBuildingEvent, applyBuildingRemoved, applyParcelEvent, bump, game, refreshMe, reloadAllChunks, toast } from './game';
import type { BuildingSummary, ParcelOwner } from './types';

interface EventMsg { type: 'event'; id: number; channel: string; event: string; payload: Record<string, unknown>; replay?: boolean }

class RealtimeClient {
  private ws: WebSocket | null = null;
  private wanted = new Set<string>();
  private lastEventId = 0;
  private retry = 0;
  private stopped = false;
  private focus: string | null = null;
  private seen = new Set<number>();

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    game.set({ connection: 'connecting' });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      game.set({ connection: 'online' });
      if (this.wanted.size) ws.send(JSON.stringify({ type: 'subscribe', channels: [...this.wanted] }));
      if (this.focus) ws.send(JSON.stringify({ type: 'presence', chunk: this.focus }));
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      game.set({ connection: 'offline' });
      if (this.stopped) return;
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Replace the set of chunk channels (other channel kinds are kept). */
  setChunks(keys: string[]) {
    const next = new Set(keys.map((k) => `chunk:${k}`));
    const drop = [...this.wanted].filter((c) => c.startsWith('chunk:') && !next.has(c));
    const add = [...next].filter((c) => !this.wanted.has(c));
    drop.forEach((c) => this.wanted.delete(c));
    add.forEach((c) => this.wanted.add(c));
    if (drop.length) this.send({ type: 'unsubscribe', channels: drop });
    if (add.length) this.send({ type: 'subscribe', channels: add });
  }

  setChannel(prefix: 'settlement' | 'market', id: string | null) {
    const drop = [...this.wanted].filter((c) => c.startsWith(`${prefix}:`) && c !== `${prefix}:${id}`);
    drop.forEach((c) => this.wanted.delete(c));
    if (drop.length) this.send({ type: 'unsubscribe', channels: drop });
    if (id && !this.wanted.has(`${prefix}:${id}`)) {
      this.wanted.add(`${prefix}:${id}`);
      this.send({ type: 'subscribe', channels: [`${prefix}:${id}`] });
    }
  }

  setFocus(chunk: string | null) {
    if (chunk === this.focus) return;
    this.focus = chunk;
    this.send({ type: 'presence', chunk });
  }

  private onMessage(m: { type: string; [k: string]: unknown }) {
    switch (m.type) {
      case 'hello': {
        const serverLast = Number(m.lastEventId);
        game.set({ online: Number(m.online) || 0 });
        if (this.lastEventId > 0 && serverLast > this.lastEventId) {
          // Reconnected: replay what we missed; refresh personal state regardless.
          this.send({ type: 'resync', since: this.lastEventId });
          refreshMe();
          bump('wallet', 'inventory', 'settlement', 'market', 'notifications');
        }
        if (this.lastEventId === 0) this.lastEventId = serverLast;
        break;
      }
      case 'resync_required':
        reloadAllChunks();
        refreshMe();
        bump('wallet', 'inventory', 'settlement', 'market', 'notifications');
        break;
      case 'online':
        game.set({ online: Number(m.count) || 0 });
        break;
      case 'presence':
        game.set((s) => ({ presence: { ...s.presence, [String(m.chunk)]: m.users as { id: string; name: string }[] } }));
        break;
      case 'event':
        this.onEvent(m as unknown as EventMsg);
        break;
    }
  }

  private onEvent(e: EventMsg) {
    if (this.seen.has(e.id)) return; // replay + live delivery can overlap
    this.seen.add(e.id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
    this.lastEventId = Math.max(this.lastEventId, e.id);
    const [kind, id] = e.channel.split(':');
    const p = e.payload;
    if (kind === 'chunk') {
      if (e.event === 'parcel') applyParcelEvent(id, p as unknown as ParcelOwner);
      else if (e.event === 'building') applyBuildingEvent(id, p.building as BuildingSummary);
      else if (e.event === 'building_removed') applyBuildingRemoved(id, String(p.id));
      bump('selection');
      return;
    }
    if (kind === 'user') {
      switch (e.event) {
        case 'wallet':
          game.set((s) => (s.me ? { me: { ...s.me, balance: Number(p.balance) } } : {}));
          bump('wallet');
          break;
        case 'inventory':
          bump('inventory');
          break;
        case 'production':
          bump('inventory', 'production');
          break;
        case 'player':
          refreshMe();
          bump('settlement');
          break;
        case 'notification':
          if (!e.replay) toast('info', String(p.title));
          game.set((s) => (s.me ? { me: { ...s.me, unreadNotifications: s.me.unreadNotifications + 1 } } : {}));
          bump('notifications');
          if (String(p.type).startsWith('settlement') || p.type === 'level_up' || p.type === 'achievement') refreshMe();
          break;
      }
      return;
    }
    if (kind === 'settlement') bump('settlement');
    if (kind === 'market') bump('market');
  }
}

export const realtime = new RealtimeClient();
