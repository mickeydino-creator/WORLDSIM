import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, userForToken } from '@/server/auth';
import AuthForm from './AuthForm';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await userForToken(token)) redirect('/play');
  return (
    <main className="relative min-h-screen overflow-hidden bg-ink-950">
      <div
        aria-hidden
        className="absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(1200px 600px at 75% 20%, rgba(63,193,165,0.10), transparent 60%), radial-gradient(900px 500px at 10% 90%, rgba(169,139,240,0.08), transparent 60%)',
        }}
      />
      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-12 px-6 py-12 lg:grid-cols-[1.1fr_0.9fr]">
        <section>
          <p className="text-xs font-medium uppercase tracking-[0.3em] text-accent">Persistent civilization</p>
          <h1 className="mt-4 text-5xl font-semibold tracking-tight text-fog-100 sm:text-6xl">WORLDSTATE</h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-fog-300">
            Settle the real Earth. Buy land on a shared map, raise homes and industry, trade with other players, and build
            settlements together. The world keeps running when you log off.
          </p>
          <ul className="mt-8 grid max-w-xl gap-3 text-sm text-fog-300 sm:grid-cols-2">
            <li className="panel rounded-lg px-4 py-3">Real geography from Natural Earth and OpenStreetMap</li>
            <li className="panel rounded-lg px-4 py-3">Server-authoritative economy with an auditable ledger</li>
            <li className="panel rounded-lg px-4 py-3">Production chains, research and a player marketplace</li>
            <li className="panel rounded-lg px-4 py-3">Settlements with roles, shared projects and votes</li>
          </ul>
          <p className="mt-8 max-w-xl text-xs text-fog-400">
            Land in WORLDSTATE is entirely virtual and paid for with in-game credits. Owning a parcel grants no real-world property rights.
          </p>
        </section>
        <AuthForm />
      </div>
    </main>
  );
}
