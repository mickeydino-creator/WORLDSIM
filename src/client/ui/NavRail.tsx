'use client';

import { game } from '../game';
import type { Panel } from '../types';

const ICONS: Record<Panel, React.ReactNode> = {
  world: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21m0-18C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9M3.5 9h17M3.5 15h17" />,
  build: <path d="M4 20h16M6 20V10l6-5 6 5v10M10 20v-5h4v5" />,
  economy: <path d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6" />,
  settlements: <path d="M3 20h18M5 20V11l4-3 4 3v9m0-6h6v6M8 13h2m-2 3h2" />,
  research: <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 15h9" />,
  profile: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0" />,
  settings: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />,
};

const LABELS: Record<Panel, string> = {
  world: 'World', build: 'Build', economy: 'Economy', settlements: 'Settlements', research: 'Research', profile: 'Profile', settings: 'Settings',
};

export default function NavRail() {
  const panel = game.use((s) => s.panel);
  return (
    <nav
      aria-label="Main navigation"
      className="panel absolute left-3 top-[64px] z-20 flex flex-col gap-1 rounded-xl p-1.5 max-sm:bottom-3 max-sm:left-3 max-sm:right-3 max-sm:top-auto max-sm:flex-row max-sm:justify-between"
    >
      {(Object.keys(LABELS) as Panel[]).map((p) => (
        <button
          key={p}
          onClick={() => game.set({ panel: p })}
          aria-current={panel === p ? 'page' : undefined}
          title={LABELS[p]}
          data-testid={`nav-${p}`}
          className={`group flex w-14 flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium transition ${panel === p ? 'bg-ink-700 text-fog-100' : 'text-fog-400 hover:bg-ink-800 hover:text-fog-200'}`}
        >
          <svg viewBox="0 0 24 24" className={`h-5 w-5 ${panel === p ? 'text-accent' : ''}`} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {ICONS[p]}
          </svg>
          {LABELS[p]}
        </button>
      ))}
    </nav>
  );
}
