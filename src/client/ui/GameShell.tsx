'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { game, refreshMe } from '../game';
import { realtime } from '../realtime';
import type { Panel } from '../types';
import NavRail from './NavRail';
import TopBar from './TopBar';
import Toasts from './Toasts';
import PlacementBar from './PlacementBar';
import WorldPanel from './WorldPanel';
import BuildPanel from './BuildPanel';
import EconomyPanel from './EconomyPanel';
import SettlementsPanel from './SettlementsPanel';
import ResearchPanel from './ResearchPanel';
import ProfilePanel from './ProfilePanel';
import SettingsPanel from './SettingsPanel';
import { ErrorBox, Loading } from './common';

const WorldMap = dynamic(() => import('../world/WorldMap'), { ssr: false, loading: () => <div className="absolute inset-0 grid place-items-center text-fog-400">Loading world…</div> });

const PANELS: Record<Panel, () => React.ReactNode> = {
  world: () => <WorldPanel />,
  build: () => <BuildPanel />,
  economy: () => <EconomyPanel />,
  settlements: () => <SettlementsPanel />,
  research: () => <ResearchPanel />,
  profile: () => <ProfilePanel />,
  settings: () => <SettingsPanel />,
};

export default function GameShell() {
  const panel = game.use((s) => s.panel);
  const me = game.use((s) => s.me);
  const meError = game.use((s) => s.meError);
  const settlementId = game.use((s) => s.me?.settlement?.id ?? null);

  useEffect(() => {
    realtime.setChannel('settlement', settlementId);
  }, [settlementId]);

  useEffect(() => {
    refreshMe().then(() => {
      const m = game.get().me;
      // Returning players start at their land; new players see the whole planet.
      if (m?.home) game.set({ view: { lng: m.home[0], lat: m.home[1], zoom: 16, bearing: 0, pitch: 55 } });
    });
    realtime.start();
    return () => realtime.stop();
  }, []);

  if (!me) {
    return (
      <div className="grid h-screen place-items-center bg-ink-950 p-6">
        {meError ? <ErrorBox message={meError} onRetry={refreshMe} /> : <Loading label="Entering WORLDSTATE" />}
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-ink-950 text-fog-100">
      <WorldMap />
      <TopBar />
      <NavRail />
      <aside
        className="panel scroll-thin absolute bottom-3 right-3 top-[64px] z-20 w-[min(400px,calc(100vw-80px))] overflow-y-auto rounded-xl max-sm:bottom-[64px] max-sm:left-3 max-sm:top-auto max-sm:h-[45vh] max-sm:w-auto"
        aria-label={`${panel} panel`}
        data-testid={`panel-${panel}`}
      >
        {PANELS[panel]()}
      </aside>
      <PlacementBar />
      <Toasts />
    </div>
  );
}
