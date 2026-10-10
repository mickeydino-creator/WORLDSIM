'use client';

import { game } from '../game';

export default function Toasts() {
  const toasts = game.use((s) => s.toasts);
  return (
    <div className="pointer-events-none absolute bottom-6 left-1/2 z-50 flex w-[min(460px,90vw)] -translate-x-1/2 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${t.kind}`}
          className={`panel pointer-events-auto rounded-lg px-4 py-2.5 text-sm ${t.kind === 'error' ? 'border-danger/50 text-danger' : t.kind === 'success' ? 'border-accent/40 text-fog-100' : 'text-fog-200'}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
