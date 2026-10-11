// Escrowed order book. Sell orders escrow goods (removed from inventory); buy orders escrow credits
// (moved to the market_escrow system account). Matching for a resource is serialised with a
// transaction-scoped advisory lock, so trades for one resource never interleave.
import { XP } from '@/shared/config/progression';
import { isResourceId, type ResourceId } from '@/shared/config/resources';
import type { Db, Tx } from '../db';
import { fail } from '../errors';
import { notifyUser, publish } from '../events';
import { playerAccountId, systemAccountId, transfer } from '../ledger';
import { addResources, removeResources, storageInfo } from './inventory';
import { addXp, checkAchievements, getModifiers, publishWallet } from './players';

export const MAX_ORDER_QUANTITY = 1_000_000;
export const MAX_PRICE_PER_UNIT = 10_000_000_00; // 10M credits
export const MAX_OPEN_ORDERS = 50;

interface OrderRow {
  id: string;
  user_id: string;
  side: 'buy' | 'sell';
  resource: ResourceId;
  price_per_unit: number;
  quantity: number;
  remaining: number;
  escrow_currency: number;
  status: string;
}

async function lockResourceBook(tx: Tx, resource: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('market:' || $1))", [resource]);
}

export interface PlaceOrderInput {
  side: 'buy' | 'sell';
  resource: string;
  pricePerUnit: number;
  quantity: number;
  expiresHours: number;
}

export async function placeOrder(tx: Tx, userId: string, input: PlaceOrderInput, opKey: string, opts: { onlyOrderId?: string; immediateOrCancel?: boolean } = {}) {
  if (!isResourceId(input.resource)) fail('invalid_input', 'Unknown resource');
  const { side, pricePerUnit: price, quantity } = input;
  if (!Number.isSafeInteger(price) || price <= 0 || price > MAX_PRICE_PER_UNIT) fail('invalid_input', 'Invalid price');
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > MAX_ORDER_QUANTITY) fail('invalid_input', 'Invalid quantity');
  const total = price * quantity;
  if (!Number.isSafeInteger(total)) fail('invalid_input', 'Order value too large');
  const resource = input.resource as ResourceId;

  await lockResourceBook(tx, resource);
  const open = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM market_orders WHERE user_id = $1 AND status = 'open'", [userId]);
  if (open.rows[0].n >= MAX_OPEN_ORDERS) fail('requirements_not_met', `At most ${MAX_OPEN_ORDERS} open orders`);

  const order = await tx.query<{ id: string }>(
    `INSERT INTO market_orders (user_id, side, resource, price_per_unit, quantity, remaining, escrow_currency, expires_at)
     VALUES ($1,$2,$3,$4,$5,$5,$6, now() + make_interval(hours => $7)) RETURNING id`,
    [userId, side, resource, price, quantity, side === 'buy' ? total : 0, input.expiresHours],
  );
  const orderId = order.rows[0].id;

  if (side === 'sell') {
    await removeResources(tx, userId, { [resource]: quantity });
  } else {
    const { capacity: cap, stock } = await storageInfo(tx, userId);
    if ((stock[resource] ?? 0) + quantity > cap) fail('storage_full', `Not enough storage to receive ${quantity} ${resource} (capacity ${cap})`);
    await transfer(tx, {
      from: await playerAccountId(tx, userId),
      to: await systemAccountId(tx, 'market_escrow'),
      amount: total,
      type: 'market_escrow',
      idempotencyKey: `${opKey}:escrow`,
      refs: { actorUserId: userId, orderId },
      insufficientMessage: 'Insufficient funds to place this buy order',
    });
  }

  const trades = await matchOrder(tx, orderId, opts.onlyOrderId);
  const after = await tx.query<OrderRow>('SELECT * FROM market_orders WHERE id = $1', [orderId]);
  if (opts.immediateOrCancel && after.rows[0].status === 'open') await closeOrder(tx, after.rows[0], 'cancelled');
  await publishWallet(tx, userId);
  await publish(tx, `user:${userId}`, 'inventory', {});
  await publish(tx, `market:${resource}`, 'book', { resource });
  const final = await tx.query<OrderRow>('SELECT * FROM market_orders WHERE id = $1', [orderId]);
  return { order: toOrder(final.rows[0]), trades };
}

/** Takes (fills) a specific resting order, immediate-or-cancel. */
export async function takeOrder(tx: Tx, userId: string, orderId: string, quantity: number, opKey: string) {
  const r = await tx.query<OrderRow>("SELECT * FROM market_orders WHERE id = $1", [orderId]);
  const o = r.rows[0];
  if (!o || o.status !== 'open') fail('unavailable', 'This order is no longer available');
  if (o.user_id === userId) fail('invalid_input', 'You cannot trade with your own order');
  return placeOrder(
    tx,
    userId,
    { side: o.side === 'buy' ? 'sell' : 'buy', resource: o.resource, pricePerUnit: o.price_per_unit, quantity: Math.min(quantity, o.remaining), expiresHours: 1 },
    opKey,
    { onlyOrderId: orderId, immediateOrCancel: true },
  );
}

async function matchOrder(tx: Tx, orderId: string, onlyOrderId?: string) {
  const trades: { id: string; quantity: number; price: number }[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const t = (await tx.query<OrderRow>('SELECT * FROM market_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (t.status !== 'open' || t.remaining === 0) break;
    const opposite = t.side === 'buy' ? 'sell' : 'buy';
    const priceCond = t.side === 'buy' ? 'price_per_unit <= $3' : 'price_per_unit >= $3';
    const order = t.side === 'buy' ? 'price_per_unit ASC' : 'price_per_unit DESC';
    const m = await tx.query<OrderRow>(
      `SELECT * FROM market_orders
        WHERE resource = $1 AND side = $2 AND status = 'open' AND ${priceCond} AND user_id <> $4 AND expires_at > now()
          AND ($5::uuid IS NULL OR id = $5)
        ORDER BY ${order}, created_at ASC LIMIT 1 FOR UPDATE`,
      [t.resource, opposite, t.price_per_unit, t.user_id, onlyOrderId ?? null],
    );
    const maker = m.rows[0];
    if (!maker) break;
    const buy = t.side === 'buy' ? t : maker;
    const sell = t.side === 'sell' ? t : maker;
    trades.push(await executeTrade(tx, buy, sell, Math.min(t.remaining, maker.remaining), maker.price_per_unit));
  }
  return trades;
}

async function executeTrade(tx: Tx, buy: OrderRow, sell: OrderRow, qty: number, price: number) {
  const total = price * qty;
  const mods = await getModifiers(tx, sell.user_id);
  const fee = Math.floor((total * mods.marketFeeBps) / 10_000);
  const trade = await tx.query<{ id: string }>(
    `INSERT INTO trades (buy_order_id, sell_order_id, buyer_user_id, seller_user_id, resource, quantity, price_per_unit, total, fee)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [buy.id, sell.id, buy.user_id, sell.user_id, buy.resource, qty, price, total, fee],
  );
  const tradeId = trade.rows[0].id;
  const escrow = await systemAccountId(tx, 'market_escrow');
  const refs = { tradeId, orderId: buy.id };
  await transfer(tx, { from: escrow, to: await playerAccountId(tx, sell.user_id), amount: total - fee, type: 'trade_payment', idempotencyKey: `trade:${tradeId}:pay`, refs, metadata: { resource: buy.resource, qty, price } });
  if (fee > 0) await transfer(tx, { from: escrow, to: await systemAccountId(tx, 'market_fees'), amount: fee, type: 'trade_fee', idempotencyKey: `trade:${tradeId}:fee`, refs });
  // Buyer escrowed at their own limit price; return any price improvement immediately.
  const improvement = (buy.price_per_unit - price) * qty;
  if (improvement > 0) await transfer(tx, { from: escrow, to: await playerAccountId(tx, buy.user_id), amount: improvement, type: 'escrow_refund', idempotencyKey: `trade:${tradeId}:improve`, refs });
  // Purchased goods are always delivered (capacity was checked when the buy order was placed).
  await addResources(tx, buy.user_id, { [buy.resource]: qty }, { ignoreCapacity: true });

  await tx.query(
    `UPDATE market_orders SET remaining = remaining - $2, escrow_currency = escrow_currency - $3,
            status = CASE WHEN remaining - $2 = 0 THEN 'filled' ELSE status END, updated_at = now() WHERE id = $1`,
    [buy.id, qty, buy.price_per_unit * qty],
  );
  await tx.query(
    `UPDATE market_orders SET remaining = remaining - $2, status = CASE WHEN remaining - $2 = 0 THEN 'filled' ELSE status END, updated_at = now() WHERE id = $1`,
    [sell.id, qty],
  );
  for (const uid of [buy.user_id, sell.user_id]) {
    await addXp(tx, uid, XP.trade);
    await checkAchievements(tx, uid, ['trades']);
  }
  await notifyUser(tx, sell.user_id, 'trade', `Sold ${qty} ${sell.resource}`, `Received ${total - fee} minor units after a ${fee} fee.`, { tradeId });
  await notifyUser(tx, buy.user_id, 'trade', `Bought ${qty} ${buy.resource}`, '', { tradeId });
  await publishWallet(tx, sell.user_id);
  await publishWallet(tx, buy.user_id);
  await publish(tx, `user:${buy.user_id}`, 'inventory', {});
  await publish(tx, `market:${buy.resource}`, 'trade', { resource: buy.resource, quantity: qty, price });
  return { id: tradeId, quantity: qty, price };
}

/** Releases escrow for an open order and closes it. Caller must hold the resource book lock. */
async function closeOrder(tx: Tx, o: OrderRow, status: 'cancelled' | 'expired') {
  if (o.side === 'sell' && o.remaining > 0) {
    await addResources(tx, o.user_id, { [o.resource]: o.remaining }, { ignoreCapacity: true });
  }
  if (o.side === 'buy' && o.escrow_currency > 0) {
    await transfer(tx, {
      from: await systemAccountId(tx, 'market_escrow'),
      to: await playerAccountId(tx, o.user_id),
      amount: o.escrow_currency,
      type: 'escrow_refund',
      idempotencyKey: `order:${o.id}:close`,
      refs: { orderId: o.id },
    });
  }
  await tx.query('UPDATE market_orders SET status = $2, escrow_currency = 0, updated_at = now() WHERE id = $1', [o.id, status]);
  await publish(tx, `user:${o.user_id}`, 'inventory', {});
  await publishWallet(tx, o.user_id);
  await publish(tx, `market:${o.resource}`, 'book', { resource: o.resource });
}

export async function cancelOrder(tx: Tx, userId: string, orderId: string) {
  const pre = await tx.query<{ resource: string }>('SELECT resource FROM market_orders WHERE id = $1', [orderId]);
  if (!pre.rows[0]) fail('not_found', 'Order not found');
  await lockResourceBook(tx, pre.rows[0].resource);
  const o = (await tx.query<OrderRow>('SELECT * FROM market_orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
  if (o.user_id !== userId) fail('forbidden', 'You can only cancel your own orders');
  if (o.status !== 'open') fail('conflict', `Order is already ${o.status}`);
  await closeOrder(tx, o, 'cancelled');
  return { orderId, status: 'cancelled' };
}

/** Worker: expire stale orders in bounded batches. */
export async function expireOrders(tx: Tx, limit = 200) {
  const due = await tx.query<{ id: string; resource: string }>(
    "SELECT id, resource FROM market_orders WHERE status = 'open' AND expires_at <= now() ORDER BY expires_at LIMIT $1",
    [limit],
  );
  let n = 0;
  for (const row of due.rows) {
    await lockResourceBook(tx, row.resource);
    const o = (await tx.query<OrderRow>('SELECT * FROM market_orders WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
    if (o.status !== 'open') continue;
    await closeOrder(tx, o, 'expired');
    await notifyUser(tx, o.user_id, 'order_expired', `Your ${o.side} order for ${o.resource} expired`, 'Escrowed funds or goods were returned.', { orderId: o.id });
    n++;
  }
  return n;
}

function toOrder(o: OrderRow & { created_at?: Date; expires_at?: Date }) {
  return {
    id: o.id,
    side: o.side,
    resource: o.resource,
    pricePerUnit: o.price_per_unit,
    quantity: o.quantity,
    remaining: o.remaining,
    status: o.status,
    createdAt: o.created_at,
    expiresAt: o.expires_at,
  };
}

export async function getOrderBook(db: Db, resource: string, userId: string) {
  if (!isResourceId(resource)) fail('invalid_input', 'Unknown resource');
  const [bids, asks, trades, mine] = await Promise.all([
    db.query(
      `SELECT o.id, o.price_per_unit AS "pricePerUnit", o.remaining, u.display_name AS "trader", o.user_id = $2 AS mine, o.expires_at AS "expiresAt"
         FROM market_orders o JOIN users u ON u.id = o.user_id
        WHERE o.resource = $1 AND o.side = 'buy' AND o.status = 'open' AND o.expires_at > now()
        ORDER BY o.price_per_unit DESC, o.created_at ASC LIMIT 25`,
      [resource, userId],
    ),
    db.query(
      `SELECT o.id, o.price_per_unit AS "pricePerUnit", o.remaining, u.display_name AS "trader", o.user_id = $2 AS mine, o.expires_at AS "expiresAt"
         FROM market_orders o JOIN users u ON u.id = o.user_id
        WHERE o.resource = $1 AND o.side = 'sell' AND o.status = 'open' AND o.expires_at > now()
        ORDER BY o.price_per_unit ASC, o.created_at ASC LIMIT 25`,
      [resource, userId],
    ),
    db.query(
      `SELECT id, quantity, price_per_unit AS "pricePerUnit", created_at AS "at" FROM trades WHERE resource = $1 ORDER BY created_at DESC LIMIT 20`,
      [resource],
    ),
    db.query<OrderRow & { created_at: Date; expires_at: Date }>(
      `SELECT * FROM market_orders WHERE user_id = $1 ORDER BY (status = 'open') DESC, created_at DESC LIMIT 30`,
      [userId],
    ),
  ]);
  const fee = (await getModifiers(db, userId)).marketFeeBps;
  return { resource, bids: bids.rows, asks: asks.rows, trades: trades.rows, myOrders: mine.rows.map(toOrder), feeBps: fee };
}

export async function marketSummary(db: Db) {
  const r = await db.query(
    `SELECT res.resource,
            (SELECT max(price_per_unit) FROM market_orders WHERE resource = res.resource AND side = 'buy' AND status = 'open' AND expires_at > now()) AS "bestBid",
            (SELECT min(price_per_unit) FROM market_orders WHERE resource = res.resource AND side = 'sell' AND status = 'open' AND expires_at > now()) AS "bestAsk",
            (SELECT price_per_unit FROM trades WHERE resource = res.resource ORDER BY created_at DESC LIMIT 1) AS "lastPrice",
            (SELECT COALESCE(sum(quantity),0)::bigint FROM trades WHERE resource = res.resource AND created_at > now() - interval '24 hours') AS "volume24h"
       FROM unnest($1::text[]) AS res(resource)`,
    [['wood', 'stone', 'metal', 'agri', 'goods', 'energy']],
  );
  return r.rows;
}
