'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../api';
import { game } from '../game';
import { formatCredits } from '@/shared/config/resources';

/** Fetches an API resource and refetches when any of the given data-version keys is bumped. */
export function useApi<T>(path: string | null, deps: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const versions = game.use((s) => deps.map((d) => s.dataVersion[d] ?? 0).join(','));
  const [nonce, setNonce] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    const ctrl = new AbortController();
    if (first.current) setLoading(true);
    apiGet<T>(path, ctrl.signal)
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (!ctrl.signal.aborted) { setLoading(false); first.current = false; } });
    return () => ctrl.abort();
  }, [path, versions, nonce]);
  useEffect(() => { first.current = true; }, [path]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export function Button({ children, onClick, variant = 'secondary', disabled, title, busy, type = 'button', className = '', ...rest }: {
  children: React.ReactNode; onClick?: () => void | Promise<unknown>; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; title?: string; busy?: boolean; type?: 'button' | 'submit'; className?: string; 'data-testid'?: string;
}) {
  const [running, setRunning] = useState(false);
  const styles = {
    primary: 'bg-accent text-ink-950 hover:bg-accent-strong font-semibold',
    secondary: 'bg-ink-700 text-fog-100 hover:bg-ink-600 border border-ink-600',
    danger: 'bg-transparent text-danger border border-danger/50 hover:bg-danger/10',
    ghost: 'bg-transparent text-fog-300 hover:text-fog-100 hover:bg-ink-800',
  }[variant];
  const isBusy = busy || running;
  return (
    <button
      type={type}
      title={title}
      aria-disabled={disabled || isBusy}
      disabled={disabled || isBusy}
      onClick={async () => {
        if (!onClick) return;
        setRunning(true);
        try { await onClick(); } finally { setRunning(false); }
      }}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:border-ink-600 disabled:bg-ink-800 disabled:text-fog-400 ${styles} ${className}`}
      {...rest}
    >
      {isBusy ? <span className="pulse-soft">Working…</span> : children}
    </button>
  );
}

/** A disabled button that explains why it is disabled. */
export function Gate({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      {children}
      {reason && <p className="text-xs text-fog-400">{reason}</p>}
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="border-t border-ink-700 px-4 py-4 first:border-t-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog-400">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <p className="pulse-soft text-sm text-fog-400" role="status">{label}…</p>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
      {onRetry && <button onClick={onRetry} className="ml-2 underline">Retry</button>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-fog-400">{children}</p>;
}

export function Credits({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`font-mono tabular-nums ${className}`}>{formatCredits(value)}</span>;
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-fog-400">{label}</span>
      <span className="text-right text-fog-100">{children}</span>
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'violet' }) {
  const t = {
    neutral: 'bg-ink-700 text-fog-300',
    accent: 'bg-accent/15 text-accent',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
    violet: 'bg-violet/15 text-violet',
  }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${t}`}>{children}</span>;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string | null }) {
  const { label, error, className = '', ...rest } = props;
  return (
    <label className="block">
      {label && <span className="text-xs text-fog-400">{label}</span>}
      <input
        {...rest}
        aria-invalid={!!error}
        className={`mt-1 w-full rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-sm text-fog-100 outline-none focus:border-accent ${className}`}
      />
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const { label, className = '', children, ...rest } = props;
  return (
    <label className="block">
      {label && <span className="text-xs text-fog-400">{label}</span>}
      <select {...rest} className={`mt-1 w-full rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-sm text-fog-100 outline-none focus:border-accent ${className}`}>
        {children}
      </select>
    </label>
  );
}

export function timeAgo(iso: string | Date) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Parses a credits string ("12.5") into minor units, or null when invalid. */
export function parseCredits(v: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(v.trim())) return null;
  const [w, f = ''] = v.trim().split('.');
  const n = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
