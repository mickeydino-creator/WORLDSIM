'use client';

import { game } from '../game';
import { getBuildingDef } from '@/shared/config/buildings';
import { Button, Credits } from './common';

export default function PlacementBar() {
  const p = game.use((s) => s.placement);
  const me = game.use((s) => s.me);
  if (!p) return null;
  const def = getBuildingDef(p.type)!;
  const rotate = (d: number) => game.set({ placement: { ...p, rotation: (p.rotation + d + 360) % 360 } });
  return (
    <div className="panel absolute bottom-20 left-1/2 z-40 w-[min(640px,92vw)] -translate-x-1/2 rounded-xl px-4 py-3" role="region" aria-label="Placement controls" data-testid="placement-bar">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{p.projectFor ? `Choose a site for: ${p.projectFor.name}` : `Placing ${def.name}`}</p>
          <p className={`text-xs ${p.valid ? 'text-accent' : 'text-danger'}`} data-testid="placement-status">
            {p.lngLat ? (p.valid ? 'Valid location. Click the map or press Enter to confirm.' : p.reason) : 'Move over the map to preview.'}
          </p>
          <p className="mt-0.5 text-[11px] text-fog-400">Mouse to aim · Arrow keys nudge · R rotate · Enter confirm · Esc cancel</p>
        </div>
        {!p.projectFor && me && <Credits value={Math.round(def.cost * me.modifiers.buildCostMultiplier)} className="text-sm text-fog-200" />}
        <div className="flex items-center gap-1">
          <Button variant="ghost" onClick={() => rotate(-15)} title="Rotate left 15°">⟲</Button>
          <span className="w-10 text-center font-mono text-xs text-fog-300" aria-label="Rotation">{p.rotation}°</span>
          <Button variant="ghost" onClick={() => rotate(15)} title="Rotate right 15°">⟳</Button>
        </div>
        <Button variant="secondary" onClick={() => game.set({ placement: null })}>Cancel</Button>
        <Button variant="primary" data-testid="confirm-placement" disabled={!p.lngLat || (!p.valid && !p.projectFor && p.reason !== null && !p.reason.includes('permission'))} onClick={() => { window.dispatchEvent(new Event('ws:confirm-placement')); }}>
          Confirm
        </Button>
      </div>
    </div>
  );
}
