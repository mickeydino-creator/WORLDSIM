'use client';

import { useState } from 'react';
import { apiPost } from '../api';
import { bump, game } from '../game';
import type { Notification } from '../types';
import { Empty, ErrorBox, Loading, timeAgo, useApi } from './common';

export default function NotificationsButton() {
  const [open, setOpen] = useState(false);
  const unread = game.use((s) => s.me?.unreadNotifications ?? 0);
  const list = useApi<{ notifications: Notification[] }>(open ? '/api/notifications' : null, ['notifications']);

  async function markAll() {
    await apiPost('/api/notifications/read', {});
    game.set((s) => (s.me ? { me: { ...s.me, unreadNotifications: 0 } } : {}));
    bump('notifications');
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Notifications (${unread} unread)`}
        className="relative rounded-md p-1.5 text-fog-300 hover:bg-ink-800 hover:text-fog-100"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 4h4" /></svg>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-[10px] font-bold text-ink-950">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="panel scroll-thin absolute right-0 top-10 z-50 max-h-[60vh] w-80 overflow-y-auto rounded-xl" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
            <span className="text-sm font-medium">Notifications</span>
            <button onClick={markAll} className="text-xs text-accent hover:underline" disabled={unread === 0}>Mark all read</button>
          </div>
          <div className="p-2">
            {list.loading && <div className="p-2"><Loading /></div>}
            {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
            {list.data && list.data.notifications.length === 0 && <div className="p-2"><Empty>No notifications yet.</Empty></div>}
            {list.data?.notifications.map((n) => (
              <div key={n.id} className={`rounded-md px-3 py-2 ${n.readAt ? '' : 'bg-ink-800'}`}>
                <p className="text-sm text-fog-100">{n.title}</p>
                {n.body && <p className="text-xs text-fog-400">{n.body}</p>}
                <p className="mt-0.5 text-[10px] text-fog-400">{timeAgo(n.at)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
