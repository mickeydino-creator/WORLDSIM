// Persistent world simulation: accrues building income, research and reputation per elapsed minute.
// Accrual is driven by each building's income_at watermark, advanced in the same transaction as the
// payout, so a tick can be retried or run by several workers without double-paying.
import { BUILDINGS, getBuildingDef, levelMultiplier } from '@/shared/config/buildings';
import { computeModifiers, type Modifiers } from '@/shared/config/research';
import type { Tx } from '../db';
import { publish } from '../events';
import { playerAccountId, settlementAccountId, systemAccountId, transfer } from '../ledger';

export const ACCRUAL_PERIOD_SEC = 60;
export const MAX_ACCRUAL_PERIODS = 24 * 60; // offline accrual capped at 24h per tick
const PRODUCING_TYPES = BUILDINGS.filter((b) => b.effects.incomePerHour || b.effects.researchPerHour || b.effects.reputationPerHour).map((b) => b.type);

interface Carry { income?: number; rp?: number; rep?: number }

async function modifiersFor(tx: Tx, userId: string, cache: Map<string, Modifiers>) {
  if (!cache.has(userId)) {
    const r = await tx.query<{ specialization: string | null; techs: string[] }>(
      `SELECT p.specialization, COALESCE(array_agg(r.tech_id) FILTER (WHERE r.tech_id IS NOT NULL), '{}') AS techs
         FROM players p LEFT JOIN player_research r ON r.user_id = p.user_id WHERE p.user_id = $1 GROUP BY p.user_id`,
      [userId],
    );
    cache.set(userId, computeModifiers(r.rows[0]?.techs ?? [], r.rows[0]?.specialization ?? null));
  }
  return cache.get(userId)!;
}

/** Processes up to `limit` buildings whose accrual is due. Returns the number processed. */
export async function accrueIncome(tx: Tx, tickId: string, limit = 500): Promise<number> {
  const due = await tx.query<{ id: string; type: string; level: number; owner_user_id: string | null; settlement_id: string | null; periods: number; accrual_carry: Carry }>(
    `SELECT id, type, level, owner_user_id, settlement_id, accrual_carry,
            LEAST($3::int, floor(extract(epoch FROM now() - income_at) / $2)::int) AS periods
       FROM buildings
      WHERE type = ANY($1) AND income_at <= now() - make_interval(secs => $2)
      ORDER BY income_at LIMIT $4 FOR UPDATE SKIP LOCKED`,
    [PRODUCING_TYPES, ACCRUAL_PERIOD_SEC, MAX_ACCRUAL_PERIODS, limit],
  );
  if (due.rows.length === 0) return 0;
  const mods = new Map<string, Modifiers>();
  const credit = new Map<string, { kind: 'player' | 'settlement'; id: string; amount: number }>();
  const rp = new Map<string, number>();
  const rep = new Map<string, number>();
  const settlementRep = new Map<string, number>();

  for (const b of due.rows) {
    const def = getBuildingDef(b.type);
    if (!def || b.periods <= 0) continue;
    const hours = (b.periods * ACCRUAL_PERIOD_SEC) / 3600;
    const m = b.owner_user_id ? await modifiersFor(tx, b.owner_user_id, mods) : null;
    const lm = levelMultiplier(b.level);
    const carry: Carry = b.accrual_carry ?? {};
    const income = (def.effects.incomePerHour ?? 0) * lm * hours * (m?.incomeMultiplier ?? 1) + (carry.income ?? 0);
    const research = (def.effects.researchPerHour ?? 0) * lm * hours + (carry.rp ?? 0);
    const reputation = (def.effects.reputationPerHour ?? 0) * lm * hours * (m?.reputationMultiplier ?? 1) + (carry.rep ?? 0);
    const wi = Math.floor(income);
    const wr = Math.floor(research);
    const wp = Math.floor(reputation);
    const nextCarry: Carry = { income: income - wi, rp: research - wr, rep: reputation - wp };
    await tx.query(
      'UPDATE buildings SET income_at = income_at + make_interval(secs => $2), accrual_carry = $3 WHERE id = $1',
      [b.id, b.periods * ACCRUAL_PERIOD_SEC, JSON.stringify(nextCarry)],
    );
    // If accrual was capped, skip the remaining backlog rather than paying it later.
    await tx.query('UPDATE buildings SET income_at = GREATEST(income_at, now() - make_interval(secs => $2)) WHERE id = $1', [b.id, ACCRUAL_PERIOD_SEC]);
    const key = b.owner_user_id ? `p:${b.owner_user_id}` : `s:${b.settlement_id}`;
    if (wi > 0) {
      const c = credit.get(key) ?? { kind: b.owner_user_id ? 'player' : 'settlement', id: (b.owner_user_id ?? b.settlement_id)!, amount: 0 };
      c.amount += wi;
      credit.set(key, c);
    }
    if (b.owner_user_id) {
      if (wr > 0) rp.set(b.owner_user_id, (rp.get(b.owner_user_id) ?? 0) + wr);
      if (wp > 0) rep.set(b.owner_user_id, (rep.get(b.owner_user_id) ?? 0) + wp);
    } else if (b.settlement_id && wp > 0) {
      settlementRep.set(b.settlement_id, (settlementRep.get(b.settlement_id) ?? 0) + wp);
    }
  }

  const mint = await systemAccountId(tx, 'mint');
  for (const c of [...credit.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const to = c.kind === 'player' ? await playerAccountId(tx, c.id) : await settlementAccountId(tx, c.id);
    await transfer(tx, {
      from: mint, to, amount: c.amount, type: 'building_income',
      idempotencyKey: `income:${tickId}:${c.kind}:${c.id}`,
      refs: c.kind === 'settlement' ? { settlementId: c.id } : { actorUserId: c.id },
    });
    if (c.kind === 'player') {
      const bal = await tx.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = $1', [to]);
      await publish(tx, `user:${c.id}`, 'wallet', { balance: bal.rows[0].balance });
    } else {
      await publish(tx, `settlement:${c.id}`, 'treasury', {});
    }
  }
  for (const uid of new Set([...rp.keys(), ...rep.keys()])) {
    await tx.query('UPDATE players SET research_points = research_points + $2, reputation = reputation + $3 WHERE user_id = $1', [uid, rp.get(uid) ?? 0, rep.get(uid) ?? 0]);
    await publish(tx, `user:${uid}`, 'player', {});
  }
  // Reputation earned by settlement-owned public buildings is shared among members.
  for (const [sid, amount] of settlementRep) {
    await tx.query('UPDATE players SET reputation = reputation + $2 WHERE user_id IN (SELECT user_id FROM settlement_members WHERE settlement_id = $1)', [sid, amount]);
  }
  return due.rows.length;
}
