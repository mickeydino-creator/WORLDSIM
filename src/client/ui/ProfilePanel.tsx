'use client';

import { game } from '../game';
import { ACHIEVEMENTS, xpForLevel } from '@/shared/config/progression';
import { SPECIALIZATIONS, type Specialization } from '@/shared/config/research';
import { Badge, Credits, ErrorBox, Loading, Row, Section, useApi } from './common';

interface Board { reputation: { username: string; displayName: string; value: number }[]; level: { username: string; displayName: string; value: number }[] }

export default function ProfilePanel() {
  const me = game.use((s) => s.me)!;
  const board = useApi<Board>('/api/leaderboard', ['player']);
  const unlocked = new Set(me.achievements.map((a) => a.id));
  const m = me.modifiers;
  return (
    <div>
      <Section title={me.displayName}>
        <Row label="Username">@{me.username}</Row>
        <Row label="Level">{me.level} <span className="text-xs text-fog-400">({me.xp} / {xpForLevel(me.level + 1)} XP)</span></Row>
        <Row label="Reputation">{me.reputation}</Row>
        <Row label="Specialization">{me.specialization ? SPECIALIZATIONS[me.specialization as Specialization].name : 'None'}</Row>
        <Row label="Settlement">{me.settlement ? `${me.settlement.name} (${me.settlement.role.replace(/_/g, ' ')})` : 'None'}</Row>
        <Row label="Parcels">{me.parcelCount} / {me.maxParcels}</Row>
        <Row label="Buildings">{me.buildingCount}</Row>
        <Row label="Wallet"><Credits value={me.balance} /></Row>
      </Section>
      <Section title="Active modifiers">
        <Row label="Construction cost">×{m.buildCostMultiplier.toFixed(2)}</Row>
        <Row label="Production time">×{m.durationMultiplier.toFixed(2)}</Row>
        <Row label="Storage">×{m.storageMultiplier.toFixed(2)}</Row>
        <Row label="Market fee">{(m.marketFeeBps / 100).toFixed(2)}%</Row>
        <Row label="Rent income">×{m.incomeMultiplier.toFixed(2)}</Row>
        {Object.entries(m.outputMultiplier).map(([k, v]) => <Row key={k} label={`${k} output`}>×{(v ?? 1).toFixed(2)}</Row>)}
      </Section>
      <Section title={`Achievements · ${unlocked.size}/${ACHIEVEMENTS.length}`}>
        <ul className="space-y-1.5">
          {ACHIEVEMENTS.map((a) => (
            <li key={a.id} className={`flex items-start justify-between gap-2 text-sm ${unlocked.has(a.id) ? '' : 'opacity-50'}`}>
              <span><span className="font-medium">{a.name}</span><span className="block text-xs text-fog-400">{a.description}</span></span>
              {unlocked.has(a.id) ? <Badge tone="accent">Unlocked</Badge> : <Badge>Locked</Badge>}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Leaderboards">
        {board.loading && !board.data && <Loading />}
        {board.error && <ErrorBox message={board.error} onRetry={board.reload} />}
        {board.data && (
          <div className="grid grid-cols-2 gap-4 text-xs">
            {(['reputation', 'level'] as const).map((k) => (
              <div key={k}>
                <p className="mb-1 font-medium capitalize text-fog-300">{k}</p>
                <ol className="space-y-0.5">
                  {board.data![k].map((r, i) => <li key={r.username} className="flex justify-between"><span>{i + 1}. {r.displayName}</span><span className="font-mono">{r.value}</span></li>)}
                </ol>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
