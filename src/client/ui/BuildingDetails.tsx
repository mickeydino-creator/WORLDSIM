'use client';

import { useState } from 'react';
import { game } from '../game';
import { cancelProduction, demolishBuilding, setAutoRepeat, startProduction, upgradeBuilding } from '../actions';
import { CATEGORY_LABELS, getBuildingDef, levelMultiplier } from '@/shared/config/buildings';
import { getRecipe } from '@/shared/config/recipes';
import { RESOURCES, type ResourceId } from '@/shared/config/resources';
import { Badge, Button, Credits, ErrorBox, Loading, Row, Section, timeAgo, useApi, useNow } from './common';

interface BuildingInfo {
  id: string; type: string; name: string; category: keyof typeof CATEGORY_LABELS; level: number; maxLevel: number; status: string;
  ownerId: string | null; ownerName: string | null; settlementId: string | null; builtBy: string; createdAt: string; parcelId: string;
  autoRepeat: boolean; lastRecipeId: string | null; canManage: boolean; canOperate: boolean;
  currentRun: { id: string; recipeId: string; outputs: Record<string, number>; currencyOut: number; startedAt: string; completesAt: string } | null;
  upgrade: { cost: number; resources: Record<string, number> } | null; demolishRefund: number;
}

function ResList({ map }: { map: Record<string, number | undefined> }) {
  const e = Object.entries(map).filter(([, q]) => (q ?? 0) > 0);
  if (!e.length) return <span className="text-fog-400">—</span>;
  return <>{e.map(([r, q]) => <span key={r} className="mr-2 whitespace-nowrap">{q} {RESOURCES[r as ResourceId]?.name.toLowerCase() ?? r}</span>)}</>;
}

export default function BuildingDetails({ id }: { id: string }) {
  const me = game.use((s) => s.me)!;
  const { data, error, loading, reload } = useApi<BuildingInfo>(`/api/buildings/${id}`, ['selection', 'production']);
  const [auto, setAuto] = useState(false);
  const [confirmDemolish, setConfirmDemolish] = useState(false);
  const now = useNow();

  if (loading && !data) return <Section title="Building"><Loading /></Section>;
  if (error) return <Section title="Building"><ErrorBox message={error} onRetry={reload} /></Section>;
  if (!data) return null;
  const b = data;
  const def = getBuildingDef(b.type)!;
  const run = b.currentRun;
  const remaining = run ? Math.max(0, Math.ceil((new Date(run.completesAt).getTime() - now) / 1000)) : 0;
  const total = run ? (new Date(run.completesAt).getTime() - new Date(run.startedAt).getTime()) / 1000 : 1;
  const lm = levelMultiplier(b.level);

  return (
    <>
      <Section title={b.name} actions={<Badge tone={b.status === 'producing' ? 'warn' : 'neutral'}>{b.status}</Badge>}>
        <Row label="Category">{CATEGORY_LABELS[b.category]}</Row>
        <Row label="Level">{b.level} / {b.maxLevel}</Row>
        <Row label="Owner">{b.ownerName ?? 'Settlement'}</Row>
        <Row label="Built">{b.builtBy}, {timeAgo(b.createdAt)}</Row>
        <p className="mt-2 text-xs text-fog-400">{def.description}</p>
        {def.effects.incomePerHour && <Row label="Income"><Credits value={Math.floor(def.effects.incomePerHour * lm)} />/h</Row>}
        {def.effects.researchPerHour && <Row label="Research">{(def.effects.researchPerHour * lm).toFixed(1)} RP/h</Row>}
        {def.effects.reputationPerHour && <Row label="Reputation">{(def.effects.reputationPerHour * lm).toFixed(1)}/h</Row>}
        {def.effects.storage && <Row label="Storage bonus">+{def.effects.storage * b.level} per resource</Row>}
      </Section>

      {def.effects.recipes?.length && (
        <Section title="Production">
          {run ? (
            <div className="space-y-2" data-testid="production-running">
              <p className="text-sm">{getRecipe(run.recipeId)?.name} → <ResList map={run.outputs} />{run.currencyOut > 0 && <Credits value={run.currencyOut} />}</p>
              <div className="h-1.5 overflow-hidden rounded bg-ink-700"><div className="h-full bg-warn transition-all" style={{ width: `${Math.min(100, 100 - (remaining / total) * 100)}%` }} /></div>
              <p className="text-xs text-fog-400">{remaining > 0 ? `${remaining}s remaining` : 'Completing…'} {b.autoRepeat && '· repeats automatically'}</p>
              {b.canOperate && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={async () => { await setAutoRepeat(b.id, !b.autoRepeat); reload(); }}>{b.autoRepeat ? 'Stop repeating' : 'Repeat automatically'}</Button>
                  <Button variant="danger" onClick={async () => { await cancelProduction(b.id); reload(); }}>Cancel run</Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {!b.canOperate && <p className="text-xs text-fog-400">Only the owner can operate this business.</p>}
              {b.canOperate && (
                <label className="flex items-center gap-2 text-xs text-fog-300">
                  <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Repeat automatically (runs while you are offline)
                </label>
              )}
              {def.effects.recipes.map((rid) => {
                const r = getRecipe(rid)!;
                const locked = (r.research ?? []).filter((t) => !me.techs.includes(t));
                const shortInputs = Object.entries(r.inputs).some(([, q]) => (q ?? 0) > 0);
                const reason = !b.canOperate ? 'Not your business' : locked.length ? `Requires research: ${locked.join(', ')}` : me.balance < r.operatingCost ? 'Not enough credits for operating cost' : null;
                return (
                  <div key={rid} className="rounded-lg border border-ink-700 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs text-fog-400">{Math.round(r.durationSec * me.modifiers.durationMultiplier)}s</span>
                    </div>
                    <p className="mt-1 text-xs text-fog-300">In: {shortInputs ? <ResList map={r.inputs} /> : 'nothing'} · cost <Credits value={r.operatingCost} /></p>
                    <p className="text-xs text-fog-300">Out: <ResList map={r.outputs} />{r.currencyOut ? <Credits value={r.currencyOut} /> : null} (×{lm.toFixed(1)} level)</p>
                    <Button className="mt-2" variant="primary" disabled={!!reason} title={reason ?? undefined} data-testid={`start-${rid}`} onClick={async () => { await startProduction(b.id, rid, auto); reload(); }}>Start</Button>
                    {reason && <p className="mt-1 text-xs text-fog-400">{reason}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {b.canManage && (
        <Section title="Manage">
          {b.upgrade ? (
            <div className="mb-3">
              <p className="text-xs text-fog-300">Upgrade to level {b.level + 1}: <Credits value={Math.round(b.upgrade.cost * me.modifiers.buildCostMultiplier)} /> <ResList map={b.upgrade.resources} /></p>
              <Button className="mt-2" variant="secondary" disabled={b.status === 'producing'} onClick={async () => { await upgradeBuilding(b.id); reload(); }}>Upgrade</Button>
              {b.status === 'producing' && <p className="mt-1 text-xs text-fog-400">Wait for production to finish before upgrading.</p>}
            </div>
          ) : <p className="mb-3 text-xs text-fog-400">Maximum level reached.</p>}
          {confirmDemolish ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-fog-300">Demolish and refund <Credits value={b.demolishRefund} />?</span>
              <Button variant="danger" onClick={() => demolishBuilding(b.id)}>Confirm</Button>
              <Button variant="ghost" onClick={() => setConfirmDemolish(false)}>Keep</Button>
            </div>
          ) : (
            <Button variant="danger" disabled={b.status === 'producing'} onClick={() => setConfirmDemolish(true)}>Demolish</Button>
          )}
        </Section>
      )}
    </>
  );
}
