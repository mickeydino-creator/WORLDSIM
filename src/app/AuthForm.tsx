'use client';

import { useState } from 'react';
import { loginSchema, registerSchema } from '@/shared/schemas';

export default function AuthForm() {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const schema = mode === 'register' ? registerSchema : loginSchema;
    const parsed = schema.safeParse(form);
    if (!parsed.success) {
      const fe: Record<string, string> = {};
      for (const i of parsed.error.issues) fe[String(i.path[0])] ??= i.message;
      setFieldErrors(fe);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed.data) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? `Request failed (HTTP ${res.status})`);
      window.location.href = '/play';
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const field = (name: string, label: string, type = 'text', autoComplete?: string) => (
    <label className="block">
      <span className="text-xs font-medium text-fog-300">{label}</span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        aria-invalid={!!fieldErrors[name]}
        className="mt-1.5 w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2.5 text-sm text-fog-100 outline-none transition focus:border-accent"
      />
      {fieldErrors[name] && <span className="mt-1 block text-xs text-danger">{fieldErrors[name]}</span>}
    </label>
  );

  return (
    <div className="panel rounded-2xl p-8">
      <div className="flex gap-1 rounded-lg bg-ink-850 p-1" role="tablist">
        {(['register', 'login'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => { setMode(m); setError(null); setFieldErrors({}); }}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${mode === m ? 'bg-ink-700 text-fog-100' : 'text-fog-400 hover:text-fog-200'}`}
          >
            {m === 'register' ? 'Create account' : 'Sign in'}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {mode === 'register' ? (
          <>
            {field('username', 'Username', 'text', 'username')}
            {field('displayName', 'Display name', 'text', 'nickname')}
            {field('email', 'Email', 'email', 'email')}
            {field('password', 'Password (10+ characters)', 'password', 'new-password')}
          </>
        ) : (
          <>
            {field('username', 'Username or email', 'text', 'username')}
            {field('password', 'Password', 'password', 'current-password')}
          </>
        )}
        {error && <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-strong disabled:opacity-60"
        >
          {busy ? 'Please wait…' : mode === 'register' ? 'Create account and enter the world' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
