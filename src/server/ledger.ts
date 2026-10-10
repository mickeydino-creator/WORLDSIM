// Server-authoritative currency. Every movement of credits is a single ledger entry between two
// accounts, applied atomically with the balance updates in the caller's transaction.
import type { Tx } from './db';
import { fail } from './errors';

export type SystemAccount = 'mint' | 'land_office' | 'construction' | 'operations' | 'market_escrow' | 'market_fees' | 'project_escrow';

export interface LedgerRefs {
  actorUserId?: string | null;
  parcelId?: string | null;
  buildingId?: string | null;
  orderId?: string | null;
  tradeId?: string | null;
  projectId?: string | null;
  settlementId?: string | null;
  productionRunId?: string | null;
}

export async function systemAccountId(tx: Tx, code: SystemAccount): Promise<string> {
  const r = await tx.query<{ id: string }>('SELECT id FROM accounts WHERE system_code = $1', [code]);
  if (!r.rows[0]) throw new Error(`system account ${code} missing`);
  return r.rows[0].id;
}

export async function playerAccountId(tx: Tx, userId: string): Promise<string> {
  const r = await tx.query<{ id: string }>('SELECT id FROM accounts WHERE user_id = $1', [userId]);
  if (!r.rows[0]) fail('not_found', 'Wallet not found');
  return r.rows[0].id;
}

export async function settlementAccountId(tx: Tx, settlementId: string): Promise<string> {
  const r = await tx.query<{ id: string }>('SELECT id FROM accounts WHERE settlement_id = $1', [settlementId]);
  if (!r.rows[0]) fail('not_found', 'Treasury not found');
  return r.rows[0].id;
}

export async function balanceOf(tx: Tx, accountId: string): Promise<number> {
  const r = await tx.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = $1', [accountId]);
  return r.rows[0]?.balance ?? 0;
}

export interface TransferInput {
  from: string;
  to: string;
  amount: number;
  type: string;
  idempotencyKey: string;
  refs?: LedgerRefs;
  metadata?: Record<string, unknown>;
  /** Message used when the source account lacks funds. */
  insufficientMessage?: string;
}

/**
 * Moves `amount` minor units. Locks both account rows in a deterministic order (by id) to avoid
 * deadlocks between opposite transfers. Fails with insufficient_funds without side effects.
 * A duplicate idempotency key violates the ledger's unique constraint and aborts the transaction.
 */
export async function transfer(tx: Tx, t: TransferInput): Promise<number> {
  if (!Number.isSafeInteger(t.amount) || t.amount <= 0) throw new Error(`invalid transfer amount ${t.amount}`);
  const ids = [t.from, t.to].sort();
  const locked = await tx.query<{ id: string; balance: number; allow_negative: boolean }>(
    'SELECT id, balance, allow_negative FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  const src = locked.rows.find((r) => r.id === t.from);
  if (!src || !locked.rows.find((r) => r.id === t.to)) throw new Error('transfer account missing');
  if (!src.allow_negative && src.balance < t.amount) {
    fail('insufficient_funds', t.insufficientMessage ?? 'Insufficient funds', { required: t.amount, available: src.balance });
  }
  await tx.query('UPDATE accounts SET balance = balance - $2, updated_at = now() WHERE id = $1', [t.from, t.amount]);
  await tx.query('UPDATE accounts SET balance = balance + $2, updated_at = now() WHERE id = $1', [t.to, t.amount]);
  const r = t.refs ?? {};
  const e = await tx.query<{ id: number }>(
    `INSERT INTO ledger_entries (tx_type, from_account, to_account, amount, idempotency_key, actor_user_id,
       parcel_id, building_id, order_id, trade_id, project_id, settlement_id, production_run_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [t.type, t.from, t.to, t.amount, t.idempotencyKey, r.actorUserId ?? null, r.parcelId ?? null, r.buildingId ?? null,
      r.orderId ?? null, r.tradeId ?? null, r.projectId ?? null, r.settlementId ?? null, r.productionRunId ?? null,
      JSON.stringify(t.metadata ?? {})],
  );
  return e.rows[0].id;
}
