'use client';

import { game } from '../game';
import { RESOURCES, RESOURCE_IDS, type ResourceId } from '@/shared/config/resources';
import { xpForLevel } from '@/shared/config/progression';
import type { Inventory } from '../types';
import { Credits, useApi } from './common';
import NotificationsButton from './Notifications';

export default function TopBar() {
  const me = game.use((s) => s.me)!;
  const connection = game.use((s) => s.connection);
  const online = game.use((s) => s.online);
  const loading = game.use((s) => s.loadingChunks > 0);
  const inv = useApi<{ inventory: Inventory }>('/api/economy', ['inventory', 'wallet']);
  const lo = xpForLevel(me.level);
  const hi = xpForLevel(me.level + 1);
  const pct = Math.min(100, Math.round(((me.xp - lo) / (hi - lo)) * 100));
  return (
    <header className="panel absolute left-3 right-3 top-3 z-30 flex h-[46px] items-center gap-4 rounded-xl px-4">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rotate-45 bg-accent" aria-hidden />
        <span className="text-sm font-semibold tracking-[0.2em] max-sm:hidden">WORLDSTATE</span>
      </div>
      <div className="h-5 w-px bg-ink-600" />
      <div className="flex items-center gap-4 overflow-x-auto text-sm" aria-label="Resources">
        <span title="Wallet balance" data-testid="balance" className="whitespace-nowrap"><Credits value={me.balance} className="text-fog-100" /></span>
        <span className="flex items-center gap-2" title={`${me.xp} XP. Next level at ${hi} XP`}>
          <span className="text-fog-400">Lv</span><span>{me.level}</span>
          <span className="h-1.5 w-16 overflow-hidden rounded bg-ink-700"><span className="block h-full bg-accent" style={{ width: `${pct}%` }} /></span>
        </span>
        <span title="Research points"><span className="text-fog-400">RP </span>{me.researchPoints}</span>
        <span title="Reputation" className="max-md:hidden"><span className="text-fog-400">Rep </span>{me.reputation}</span>
        <span className="flex items-center gap-3 max-lg:hidden" title={inv.data ? `Storage capacity ${inv.data.inventory.capacity} per resource` : ''}>
          {RESOURCE_IDS.map((r: ResourceId) => (
            <span key={r} className="flex items-center gap-1" title={RESOURCES[r].name}>
              <span className="h-2 w-2 rounded-sm" style={{ background: RESOURCES[r].color }} aria-hidden />
              <span className="font-mono text-xs tabular-nums text-fog-200">{inv.data ? inv.data.inventory.items[r] : '–'}</span>
            </span>
          ))}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3 text-xs">
        {loading && <span className="pulse-soft text-fog-400">Loading area…</span>}
        <span className="flex items-center gap-1.5 text-fog-400" title="Realtime connection" data-testid="connection">
          <span className={`h-2 w-2 rounded-full ${connection === 'online' ? 'bg-accent' : connection === 'connecting' ? 'bg-warn pulse-soft' : 'bg-danger'}`} />
          {connection === 'online' ? `${online} online` : connection === 'connecting' ? 'Connecting' : 'Offline – reconnecting'}
        </span>
        <NotificationsButton />
      </div>
    </header>
  );
}
