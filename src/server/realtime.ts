// WebSocket realtime gateway. The database is the source of truth: this module only relays
// committed outbox events (world_events, announced by pg_notify) to clients subscribed to the
// matching channel, plus transient presence. It never mutates game state.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import pg from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';
import { SESSION_COOKIE, parseCookies, userForToken, type SessionUser } from './auth';
import { getPool } from './db';
import { EVENTS_CHANNEL } from './events';
import { log, reportError } from './log';
import { parseChunkKey } from '@/shared/grid';
import { isResourceId } from '@/shared/config/resources';

export const MAX_SUBSCRIPTIONS = 200;
export const MAX_CONNECTIONS_PER_USER = 5;
const RESYNC_LIMIT = 500;

interface Client {
  ws: WebSocket;
  user: SessionUser;
  channels: Set<string>;
  focusChunk: string | null;
  alive: boolean;
}

interface EventRow { id: number; channel: string; type: string; payload: unknown; created_at: Date }

export class RealtimeHub {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private clients = new Set<Client>();
  private byChannel = new Map<string, Set<Client>>();
  private listener: pg.Client | null = null;
  private pending: number[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private closed = false;

  async start() {
    await this.connectListener();
    this.timers.push(setInterval(() => this.heartbeat(), 30_000));
    this.timers.push(setInterval(() => this.broadcastOnline(), 15_000));
  }

  async stop() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    for (const c of this.clients) c.ws.terminate();
    await this.listener?.end().catch(() => undefined);
    this.wss.close();
  }

  private async connectListener() {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'worldstate-realtime' });
    client.on('notification', (msg) => {
      if (msg.channel !== EVENTS_CHANNEL || !msg.payload) return;
      this.pending.push(Number(msg.payload));
      this.flushTimer ??= setTimeout(() => this.flush(), 15);
    });
    client.on('error', (err) => {
      log.error('realtime listener error', { err: err.message });
      this.reconnect();
    });
    client.on('end', () => this.reconnect());
    await client.connect();
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    this.listener = client;
    log.info('realtime listening for events');
  }

  private reconnecting = false;
  private reconnect() {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.listener = null;
    setTimeout(async () => {
      try {
        await this.connectListener();
        // Events may have been missed while disconnected: ask every client to resync.
        for (const c of this.clients) this.send(c, { type: 'resync_required' });
      } catch (err) {
        reportError(err, { where: 'realtime reconnect' });
      } finally {
        this.reconnecting = false;
        if (!this.listener) this.reconnect();
      }
    }, 1000);
  }

  private async flush() {
    this.flushTimer = null;
    const ids = this.pending.splice(0);
    if (ids.length === 0) return;
    try {
      const r = await getPool().query<EventRow>('SELECT id, channel, type, payload, created_at FROM world_events WHERE id = ANY($1) ORDER BY id', [ids]);
      for (const e of r.rows) await this.dispatch(e);
    } catch (err) {
      reportError(err, { where: 'realtime flush' });
    }
  }

  // Settlement channels are re-authorised on delivery (cached briefly) so removed members stop
  // receiving events even if their socket stays open.
  private membership = new Map<string, { ok: boolean; at: number }>();

  private async isMember(settlementId: string, userId: string): Promise<boolean> {
    const key = `${settlementId}:${userId}`;
    const hit = this.membership.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.ok;
    const r = await getPool().query('SELECT 1 FROM settlement_members WHERE settlement_id = $1 AND user_id = $2', [settlementId, userId]);
    const ok = (r.rowCount ?? 0) > 0;
    this.membership.set(key, { ok, at: Date.now() });
    if (this.membership.size > 20_000) this.membership.clear();
    return ok;
  }

  private async dispatch(e: EventRow) {
    const subs = this.byChannel.get(e.channel);
    if (!subs) return;
    const msg = JSON.stringify({ type: 'event', id: e.id, channel: e.channel, event: e.type, payload: e.payload, at: e.created_at });
    const settlementId = e.channel.startsWith('settlement:') ? e.channel.slice('settlement:'.length) : null;
    if (settlementId && e.type === 'activity') {
      // Membership changes invalidate cached authorisations for this settlement.
      for (const k of this.membership.keys()) if (k.startsWith(`${settlementId}:`)) this.membership.delete(k);
    }
    for (const c of [...subs]) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      if (settlementId && !(await this.isMember(settlementId, c.user.id))) {
        this.unsubscribe(c, e.channel);
        continue;
      }
      c.ws.send(msg);
    }
  }

  private send(c: Client, msg: unknown) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const okOrigin = !!origin && (origin === process.env.APP_ORIGIN || origin === `http://${host}` || origin === `https://${host}`);
    const user = okOrigin ? await userForToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]).catch(() => null) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const existing = [...this.clients].filter((c) => c.user.id === user.id);
    if (existing.length >= MAX_CONNECTIONS_PER_USER) existing[0].ws.close(4000, 'too many connections');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user));
  }

  private onConnection(ws: WebSocket, user: SessionUser) {
    const c: Client = { ws, user, channels: new Set(), focusChunk: null, alive: true };
    this.clients.add(c);
    this.subscribe(c, `user:${user.id}`);
    this.subscribe(c, 'global');
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data) => {
      this.onMessage(c, data.toString()).catch((err) => reportError(err, { where: 'realtime message' }));
    });
    ws.on('close', () => this.drop(c));
    ws.on('error', () => this.drop(c));
    getPool().query<{ m: number }>('SELECT COALESCE(max(id), 0)::bigint AS m FROM world_events')
      .then((r) => this.send(c, { type: 'hello', userId: user.id, lastEventId: r.rows[0].m, online: this.onlineCount() }))
      .catch(() => undefined);
  }

  private drop(c: Client) {
    if (!this.clients.delete(c)) return;
    const focus = c.focusChunk;
    for (const ch of c.channels) this.byChannel.get(ch)?.delete(c);
    if (focus) this.broadcastPresence(focus);
  }

  private async canSubscribe(c: Client, ch: string): Promise<boolean> {
    const [kind, id] = ch.split(':');
    if (ch === 'global') return true;
    if (kind === 'chunk') return !!id && !!parseChunkKey(id);
    if (kind === 'market') return !!id && isResourceId(id);
    if (kind === 'user') return id === c.user.id;
    if (kind === 'settlement') {
      const r = await getPool().query('SELECT 1 FROM settlement_members WHERE settlement_id = $1 AND user_id = $2', [id, c.user.id]).catch(() => ({ rowCount: 0 }));
      return (r.rowCount ?? 0) > 0;
    }
    return false;
  }

  private subscribe(c: Client, ch: string) {
    c.channels.add(ch);
    let set = this.byChannel.get(ch);
    if (!set) this.byChannel.set(ch, (set = new Set()));
    set.add(c);
  }

  private unsubscribe(c: Client, ch: string) {
    if (ch === `user:${c.user.id}` || ch === 'global') return;
    c.channels.delete(ch);
    const set = this.byChannel.get(ch);
    set?.delete(c);
    if (set && set.size === 0) this.byChannel.delete(ch);
  }

  private async onMessage(c: Client, raw: string) {
    let msg: { type?: string; channels?: unknown; since?: unknown; chunk?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const channels = Array.isArray(msg.channels) ? msg.channels.filter((x): x is string => typeof x === 'string').slice(0, MAX_SUBSCRIPTIONS) : [];
    switch (msg.type) {
      case 'subscribe': {
        const accepted: string[] = [];
        for (const ch of channels) {
          if (c.channels.size >= MAX_SUBSCRIPTIONS) break;
          if (await this.canSubscribe(c, ch)) { this.subscribe(c, ch); accepted.push(ch); }
        }
        this.send(c, { type: 'subscribed', channels: accepted });
        for (const ch of accepted) if (ch.startsWith('chunk:')) this.sendPresence(c, ch.slice(6));
        break;
      }
      case 'unsubscribe':
        for (const ch of channels) this.unsubscribe(c, ch);
        break;
      case 'resync': {
        // Replay committed events the client missed while disconnected.
        const since = Number(msg.since);
        if (!Number.isSafeInteger(since) || since < 0) return;
        const r = await getPool().query<EventRow>(
          'SELECT id, channel, type, payload, created_at FROM world_events WHERE id > $1 AND channel = ANY($2) ORDER BY id LIMIT $3',
          [since, [...c.channels], RESYNC_LIMIT + 1],
        );
        if (r.rows.length > RESYNC_LIMIT) {
          this.send(c, { type: 'resync_required' });
          return;
        }
        for (const e of r.rows) this.send(c, { type: 'event', id: e.id, channel: e.channel, event: e.type, payload: e.payload, at: e.created_at, replay: true });
        this.send(c, { type: 'resynced' });
        break;
      }
      case 'presence': {
        const chunk = typeof msg.chunk === 'string' && parseChunkKey(msg.chunk) ? msg.chunk : null;
        const prev = c.focusChunk;
        if (prev === chunk) return;
        c.focusChunk = chunk;
        if (prev) this.broadcastPresence(prev);
        if (chunk) this.broadcastPresence(chunk);
        break;
      }
    }
  }

  private presenceList(chunk: string) {
    const users = new Map<string, string>();
    for (const c of this.clients) if (c.focusChunk === chunk) users.set(c.user.id, c.user.displayName);
    return [...users].map(([id, name]) => ({ id, name }));
  }

  private sendPresence(c: Client, chunk: string) {
    this.send(c, { type: 'presence', chunk, users: this.presenceList(chunk) });
  }

  private broadcastPresence(chunk: string) {
    const subs = this.byChannel.get(`chunk:${chunk}`);
    if (!subs) return;
    const msg = JSON.stringify({ type: 'presence', chunk, users: this.presenceList(chunk) });
    for (const c of subs) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }

  onlineCount() {
    return new Set([...this.clients].map((c) => c.user.id)).size;
  }

  private broadcastOnline() {
    const msg = JSON.stringify({ type: 'online', count: this.onlineCount() });
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }

  private heartbeat() {
    for (const c of this.clients) {
      if (!c.alive) { c.ws.terminate(); this.drop(c); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }
}
