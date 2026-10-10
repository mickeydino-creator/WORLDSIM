'use client';

import { apiPost } from '../api';
import { game, refreshMe } from '../game';
import { run } from '../actions';
import { SPECIALIZATIONS, SPECIALIZATION_CHANGE_COST_RP, TECHS, techCost, type Specialization } from '@/shared/config/research';
import { getBuildingDef } from '@/shared/config/buildings';
import { getRecipe } from '@/shared/config/recipes';
import { Badge, Button, Section } from './common';

export default function ResearchPanel() {
  const me = game.use((s) => s.me)!;
  const branches = Object.keys(SPECIALIZATIONS) as Specialization[];
  return (
    <div>
      <Section title="Research points">
        <p className="text-2xl font-semibold" data-testid="rp">{me.researchPoints} RP</p>
        <p className="text-xs text-fog-400">Earned from completed production runs, schools and achievements. Research unlocks buildings, recipes and permanent bonuses.</p>
      </Section>
      <Section title="Specialization">
        <p className="mb-2 text-xs text-fog-400">{me.specialization ? `Changing costs ${SPECIALIZATION_CHANGE_COST_RP} RP.` : 'Your first choice is free.'}</p>
        <div className="grid grid-cols-2 gap-2">
          {branches.map((b) => {
            const active = me.specialization === b;
            const block = active ? null : me.specialization && me.researchPoints < SPECIALIZATION_CHANGE_COST_RP ? `Needs ${SPECIALIZATION_CHANGE_COST_RP} RP` : null;
            return (
              <button
                key={b}
                disabled={active || !!block}
                title={block ?? SPECIALIZATIONS[b].description}
                onClick={async () => { if (await run(() => apiPost('/api/research/specialization', { specialization: b }), `Specialized in ${SPECIALIZATIONS[b].name}`)) refreshMe(); }}
                className={`rounded-lg border p-2 text-left transition disabled:cursor-not-allowed ${active ? 'border-accent bg-accent/10' : 'border-ink-700 hover:border-ink-500 disabled:opacity-50'}`}
              >
                <p className="text-sm font-medium">{SPECIALIZATIONS[b].name}</p>
                <p className="text-[11px] text-fog-400">{SPECIALIZATIONS[b].description}</p>
              </button>
            );
          })}
        </div>
      </Section>
      {branches.map((branch) => (
        <Section key={branch} title={SPECIALIZATIONS[branch].name}>
          <ul className="space-y-2">
            {TECHS.filter((t) => t.branch === branch).map((t) => {
              const done = me.techs.includes(t.id);
              const missing = t.prereqs.filter((p) => !me.techs.includes(p));
              const cost = techCost(t, me.specialization);
              const reason = done ? null : missing.length ? `Requires ${missing.map((m) => TECHS.find((x) => x.id === m)?.name).join(', ')}` : me.researchPoints < cost ? `Needs ${cost} RP` : null;
              const unlocks = [
                ...(t.effects.unlockBuildings ?? []).map((b) => getBuildingDef(b)?.name),
                ...(t.effects.unlockRecipes ?? []).map((r) => getRecipe(r)?.name),
              ].filter(Boolean);
              return (
                <li key={t.id} className={`rounded-lg border p-3 ${done ? 'border-accent/50' : 'border-ink-700'}`} data-testid={`tech-${t.id}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{t.name}</span>
                    {done ? <Badge tone="accent">Researched</Badge> : <Badge>{cost} RP</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-fog-300">{t.description}</p>
                  {unlocks.length > 0 && <p className="text-xs text-fog-400">Unlocks: {unlocks.join(', ')}</p>}
                  {!done && (
                    <div className="mt-2 flex items-center gap-2">
                      <Button variant="primary" disabled={!!reason} onClick={async () => { if (await run(() => apiPost(`/api/research/${t.id}`), `Researched ${t.name}`)) refreshMe(); }}>Research</Button>
                      {reason && <span className="text-xs text-fog-400">{reason}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </div>
  );
}
