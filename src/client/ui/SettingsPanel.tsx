'use client';

import { useState } from 'react';
import { apiPost } from '../api';
import { game, refreshMe } from '../game';
import { run } from '../actions';
import { Button, Empty, ErrorBox, Input, Loading, Section, timeAgo, useApi } from './common';

export default function SettingsPanel() {
  const me = game.use((s) => s.me)!;
  const [name, setName] = useState(me.displayName);
  const [pw, setPw] = useState({ current: '', next: '' });
  const sessions = useApi<{ sessions: { id: string; createdAt: string; lastSeenAt: string; userAgent: string | null; current: boolean }[] }>('/api/settings/sessions');

  return (
    <div>
      <Section title="Profile">
        <form className="flex items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await run(() => apiPost('/api/settings/profile', { displayName: name.trim() }), 'Display name updated'))) refreshMe(); }}>
          <div className="flex-1"><Input label="Display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} error={!name.trim() ? 'Required' : null} /></div>
          <Button type="submit" disabled={!name.trim() || name.trim() === me.displayName}>Save</Button>
        </form>
      </Section>
      <Section title="Password">
        <form className="space-y-2" onSubmit={async (e) => {
          e.preventDefault();
          if (pw.next.length < 10) return;
          if (await run(() => apiPost('/api/settings/password', { currentPassword: pw.current, newPassword: pw.next }), 'Password changed. Other sessions were signed out.')) { setPw({ current: '', next: '' }); sessions.reload(); }
        }}>
          <Input label="Current password" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <Input label="New password (10+ characters)" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} error={pw.next && pw.next.length < 10 ? 'At least 10 characters' : null} />
          <Button type="submit" disabled={!pw.current || pw.next.length < 10}>Change password</Button>
        </form>
      </Section>
      <Section title="Sessions">
        {sessions.loading && !sessions.data && <Loading />}
        {sessions.error && <ErrorBox message={sessions.error} onRetry={sessions.reload} />}
        {sessions.data?.sessions.length === 0 && <Empty>No sessions.</Empty>}
        <ul className="space-y-1 text-xs">
          {sessions.data?.sessions.map((s) => (
            <li key={s.id} className="flex justify-between gap-2"><span className="truncate text-fog-300">{s.current ? 'This device' : (s.userAgent ?? 'Unknown device').slice(0, 50)}</span><span className="shrink-0 text-fog-400">active {timeAgo(s.lastSeenAt)}</span></li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" disabled={(sessions.data?.sessions.length ?? 0) <= 1} onClick={async () => { if (await run(() => apiPost('/api/settings/sessions'), 'Other sessions signed out')) sessions.reload(); }}>Sign out other devices</Button>
          <Button variant="danger" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/'; }}>Sign out</Button>
        </div>
      </Section>
      <Section title="About">
        <p className="text-xs text-fog-400">Map data © OpenStreetMap contributors via OpenFreeMap; geography from Natural Earth (public domain); terrain from Mapzen/Tilezen terrain tiles. All land and currency in WORLDSTATE are virtual and carry no real-world rights or value.</p>
      </Section>
    </div>
  );
}
