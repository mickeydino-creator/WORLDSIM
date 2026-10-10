'use client';

import { useEffect, useState } from 'react';
import { apiPost } from '../api';
import { bump, flyTo, game, refreshMe } from '../game';
import { run } from '../actions';
import { getBuildingDef } from '@/shared/config/buildings';
import { RESOURCES, type ResourceId, formatCredits } from '@/shared/config/resources';
import { PROJECT_TYPES, ROLE_LABELS, ROLE_RANK, SETTLEMENT_FOUNDING_COST, SETTLEMENT_MIN_LEVEL, getProjectType, hasPermission, type SettlementRole } from '@/shared/config/settlements';
import { Badge, Button, Credits, Empty, ErrorBox, Input, Loading, Row, Section, Select, parseCredits, timeAgo, useApi, useNow } from './common';

interface SettlementData {
  id: string; name: string; description: string; founderId: string; treasury: number; lng: number; lat: number; createdAt: string;
  governance: { quorumPct: number; approvalPct: number; votingHours: number };
  tier: { name: string; memberCap: number }; myRole: SettlementRole | null;
  members: { userId: string; name: string; username: string; role: SettlementRole; level: number; reputation: number }[];
  projects: { id: string; type: string; name: string; status: string; statusNote: string | null; costCurrency: number; fundedCurrency: number; requiredResources: Record<string, number>; fundedResources: Record<string, number>; proposedBy: string; lng: number | null; lat: number | null }[];
  proposals: { id: string; type: string; title: string; payload: Record<string, unknown>; status: string; quorumPct: number; approvalPct: number; eligible: number; closesAt: string; canVote: boolean; myVote: string | null; yes: number; no: number; abstain: number; proposedBy: string; result: { note?: string | null } | null }[];
  activity: { id: number; type: string; payload: Record<string, unknown>; at: string; actor: string | null }[];
  parcels: { id: string; lng: number; lat: number; buildings: number }[];
  invites: { id: string; invitee: string; username: string }[];
}

function NoSettlement() {
  const me = game.use((s) => s.me)!;
  const view = game.use((s) => s.view);
  const invites = useApi<{ invites: { id: string; settlementName: string; invitedBy: string; createdAt: string }[] }>('/api/invites', ['notifications', 'settlement']);
  const list = useApi<{ settlements: { id: string; name: string; description: string; members: number; tier: string; founder: string; distanceM: number | null; lng: number; lat: number }[] }>(`/api/settlements?lng=${view.lng.toFixed(2)}&lat=${view.lat.toFixed(2)}`, ['settlement']);
  const parcels = useApi<{ parcels: { id: string }[] }>('/api/parcels/mine', ['wallet']);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parcelId, setParcelId] = useState('');
  const block = me.level < SETTLEMENT_MIN_LEVEL ? `Requires level ${SETTLEMENT_MIN_LEVEL}` : me.balance < SETTLEMENT_FOUNDING_COST ? 'Not enough credits' : !parcels.data?.parcels.length ? 'Own a parcel first' : null;

  return (
    <>
      <Section title="Invitations">
        {invites.loading && !invites.data && <Loading />}
        {invites.error && <ErrorBox message={invites.error} onRetry={invites.reload} />}
        {invites.data?.invites.length === 0 && <Empty>No pending invitations.</Empty>}
        {invites.data?.invites.map((i) => (
          <div key={i.id} className="mb-2 rounded-lg border border-ink-700 p-3">
            <p className="text-sm">{i.settlementName}</p>
            <p className="text-xs text-fog-400">Invited by {i.invitedBy} {timeAgo(i.createdAt)}</p>
            <div className="mt-2 flex gap-2">
              <Button variant="primary" data-testid="accept-invite" onClick={async () => { if (await run(() => apiPost(`/api/invites/${i.id}/respond`, { accept: true }), `Joined ${i.settlementName}`)) { await refreshMe(); bump('settlement'); } }}>Accept</Button>
              <Button variant="ghost" onClick={async () => { if (await run(() => apiPost(`/api/invites/${i.id}/respond`, { accept: false }), 'Invitation declined')) invites.reload(); }}>Decline</Button>
            </div>
          </div>
        ))}
      </Section>
      <Section title="Found a settlement">
        <form className="space-y-2" onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim().length < 3 || !parcelId) return;
          const r = await run(() => apiPost<{ id: string }>('/api/settlements', { name: name.trim(), description: description.trim(), parcelId }), `Founded ${name}`);
          if (r) { await refreshMe(); bump('settlement', 'wallet'); }
        }}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} error={name && name.trim().length < 3 ? 'At least 3 characters' : null} data-testid="settlement-name" />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          <Select label="Founding parcel (becomes settlement land)" value={parcelId} onChange={(e) => setParcelId(e.target.value)} data-testid="settlement-parcel">
            <option value="">Choose one of your parcels…</option>
            {parcels.data?.parcels.map((p) => <option key={p.id} value={p.id}>#{p.id}</option>)}
          </Select>
          <p className="text-xs text-fog-400">The founding fee of {formatCredits(SETTLEMENT_FOUNDING_COST)} seeds the settlement treasury.</p>
          <Button type="submit" variant="primary" disabled={!!block || name.trim().length < 3 || !parcelId}>Found settlement</Button>
          {block && <p className="text-xs text-fog-400">{block}</p>}
        </form>
      </Section>
      <Section title="Settlements near you">
        {list.loading && !list.data && <Loading />}
        {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
        {list.data?.settlements.length === 0 && <Empty>No settlements yet. Be the first.</Empty>}
        <ul className="space-y-1">
          {list.data?.settlements.map((s) => (
            <li key={s.id}>
              <button className="w-full rounded-md px-2 py-1.5 text-left hover:bg-ink-800" onClick={() => flyTo(s.lng, s.lat, 15.5)}>
                <span className="flex justify-between text-sm"><span>{s.name}</span><Badge tone="violet">{s.tier}</Badge></span>
                <span className="text-xs text-fog-400">{s.members} members · founded by {s.founder}{s.distanceM != null && ` · ${(s.distanceM / 1000).toFixed(0)} km`}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-fog-400">Settlements grow by invitation: ask a member with invite rights to invite your username.</p>
      </Section>
    </>
  );
}

function ProjectCard({ p, s }: { p: SettlementData['projects'][number]; s: SettlementData }) {
  const role = s.myRole!;
  const [amount, setAmount] = useState('');
  const [res, setRes] = useState<Record<string, string>>({});
  const minor = parseCredits(amount);
  const pct = p.costCurrency ? Math.round((p.fundedCurrency / p.costCurrency) * 100) : 100;
  const needRes = Object.entries(p.requiredResources).filter(([r, q]) => (p.fundedResources[r] ?? 0) < q);
  const contribute = async (fromTreasury: boolean) => {
    const resources: Record<string, number> = {};
    for (const [r, v] of Object.entries(res)) if (/^\d+$/.test(v) && Number(v) > 0) resources[r] = Number(v);
    const body = { currency: minor ?? undefined, resources: fromTreasury ? undefined : resources, fromTreasury };
    const r = await run(() => apiPost<{ completed: boolean }>(`/api/projects/${p.id}/contribute`, body), (x) => (x.completed ? `${p.name} completed!` : 'Contribution recorded'));
    if (r) { setAmount(''); setRes({}); bump('settlement', 'inventory', 'wallet'); refreshMe(); }
  };
  return (
    <li className="rounded-lg border border-ink-700 p-3" data-testid={`project-${p.id}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{p.name}</span>
        <Badge tone={p.status === 'completed' ? 'accent' : p.status === 'active' ? 'warn' : p.status === 'blocked' ? 'danger' : 'neutral'}>{p.status}</Badge>
      </div>
      <p className="text-xs text-fog-400">{getProjectType(p.type)?.name} · proposed by {p.proposedBy}</p>
      {p.statusNote && <p className="mt-1 text-xs text-danger">{p.statusNote}</p>}
      <div className="mt-2 h-1.5 overflow-hidden rounded bg-ink-700"><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>
      <p className="mt-1 text-xs text-fog-300"><Credits value={p.fundedCurrency} /> / <Credits value={p.costCurrency} /></p>
      {Object.keys(p.requiredResources).length > 0 && (
        <p className="text-xs text-fog-300">{Object.entries(p.requiredResources).map(([r, q]) => <span key={r} className="mr-2">{p.fundedResources[r] ?? 0}/{q} {RESOURCES[r as ResourceId]?.name.toLowerCase()}</span>)}</p>
      )}
      {p.lng != null && <button className="mt-1 text-xs text-accent hover:underline" onClick={() => flyTo(p.lng!, p.lat!, 17.5)}>Show site</button>}
      {p.status === 'active' && (
        <div className="mt-2 space-y-2">
          <Input label="Credits" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" error={amount && !minor ? 'Enter an amount like 250' : null} />
          {needRes.map(([r]) => (
            <Input key={r} label={`${RESOURCES[r as ResourceId]?.name}`} value={res[r] ?? ''} onChange={(e) => setRes({ ...res, [r]: e.target.value })} inputMode="numeric" />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!hasPermission(role, 'contribute') || (!minor && !Object.values(res).some((v) => Number(v) > 0))} onClick={() => contribute(false)} data-testid="contribute">Contribute</Button>
            {hasPermission(role, 'approve_spending') && <Button variant="secondary" disabled={!minor} onClick={() => contribute(true)}>Fund from treasury</Button>}
          </div>
        </div>
      )}
      {(p.status === 'active' || p.status === 'blocked') && hasPermission(role, 'approve_spending') && (
        <Button variant="ghost" className="mt-2" onClick={async () => { if (await run(() => apiPost(`/api/projects/${p.id}/cancel`), 'Project cancelled; contributions refunded')) { bump('settlement', 'wallet', 'inventory'); refreshMe(); } }}>Cancel project & refund</Button>
      )}
    </li>
  );
}

function NewProject({ s }: { s: SettlementData }) {
  const [type, setType] = useState('public_park');
  const [name, setName] = useState('');
  const [site, setSite] = useState<{ parcelId: string; lng: number; lat: number; rotation: number } | null>(null);
  const [target, setTarget] = useState('');
  const pt = getProjectType(type)!;
  useEffect(() => {
    const onSite = (e: Event) => {
      const d = (e as CustomEvent).detail;
      setSite(d);
      game.set({ placement: null });
    };
    window.addEventListener('ws:project-site', onSite);
    return () => window.removeEventListener('ws:project-site', onSite);
  }, []);
  const chooseSite = () => {
    if (!pt.building) return;
    if (s.parcels[0]) flyTo(s.parcels[0].lng, s.parcels[0].lat, 17.5);
    game.set({ placement: { type: pt.building, rotation: 0, lngLat: null, parcelId: null, valid: true, reason: null, projectFor: { settlementId: s.id, projectType: type, name: name || pt.name } } });
  };
  const settlementBuildings = game.use((st) => [...st.chunks.values()].flatMap((c) => c.buildings).filter((b) => b.settlementId === s.id));
  const def = pt.building ? getBuildingDef(pt.building) : null;
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      const body = pt.upgradeExisting ? { type, name: name.trim(), targetBuildingId: target } : { type, name: name.trim(), ...site };
      const r = await run(() => apiPost('/api/settlements/' + s.id + '/projects', body), 'Project proposed');
      if (r) { setName(''); setSite(null); bump('settlement'); }
    }}>
      <Select label="Project type" value={type} onChange={(e) => { setType(e.target.value); setSite(null); }}>
        {PROJECT_TYPES.map((p) => <option key={p.type} value={p.type}>{p.name}</option>)}
      </Select>
      <p className="text-xs text-fog-400">{pt.description}{def && ` Cost ≈ ${formatCredits(Math.round(def.cost * pt.costMultiplier))}.`}</p>
      <Input label="Project name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} error={name && name.trim().length < 3 ? 'At least 3 characters' : null} />
      {pt.upgradeExisting ? (
        <Select label="Settlement building to upgrade" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose…</option>
          {settlementBuildings.map((b) => <option key={b.id} value={b.id}>{getBuildingDef(b.type)?.name} (Lv {b.level})</option>)}
        </Select>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={chooseSite} disabled={!s.parcels.length}>{site ? 'Change site' : 'Choose site on map'}</Button>
          <span className="text-xs text-fog-400">{site ? `Parcel #${site.parcelId}` : s.parcels.length ? 'Pick a spot on settlement land' : 'The settlement owns no land yet'}</span>
        </div>
      )}
      <Button type="submit" variant="primary" disabled={name.trim().length < 3 || (pt.upgradeExisting ? !target : !site)}>Propose project</Button>
    </form>
  );
}

function NewProposal({ s }: { s: SettlementData }) {
  const [type, setType] = useState<'treasury_transfer' | 'role_change' | 'remove_member' | 'governance_change'>('treasury_transfer');
  const [title, setTitle] = useState('');
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [role, setRole] = useState('leader');
  const [g, setG] = useState({ quorumPct: String(s.governance.quorumPct), approvalPct: String(s.governance.approvalPct), votingHours: String(s.governance.votingHours) });
  const minor = parseCredits(amount);
  const payload = type === 'treasury_transfer' ? { toUserId: userId, amount: minor } : type === 'role_change' ? { userId, role } : type === 'remove_member' ? { userId } : { quorumPct: Number(g.quorumPct), approvalPct: Number(g.approvalPct), votingHours: Number(g.votingHours) };
  const ok = title.trim().length >= 3 && (type === 'governance_change' || userId) && (type !== 'treasury_transfer' || minor);
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      if (!ok) return;
      const r = await run(() => apiPost(`/api/settlements/${s.id}/proposals`, { type, title: title.trim(), payload }), 'Vote opened');
      if (r) { setTitle(''); setAmount(''); bump('settlement'); }
    }}>
      <Select label="Proposal" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
        <option value="treasury_transfer">Pay a member from the treasury</option>
        <option value="role_change">Change a member&apos;s role</option>
        <option value="remove_member">Remove a member</option>
        <option value="governance_change">Change voting rules</option>
      </Select>
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
      {type !== 'governance_change' && (
        <Select label="Member" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose…</option>
          {s.members.filter((m) => type === 'treasury_transfer' || m.role !== 'founder').map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </Select>
      )}
      {type === 'treasury_transfer' && <Input label="Amount (CR)" value={amount} onChange={(e) => setAmount(e.target.value)} error={amount && !minor ? 'Invalid amount' : null} />}
      {type === 'role_change' && (
        <Select label="New role" value={role} onChange={(e) => setRole(e.target.value)}>
          {(['leader', 'treasurer', 'infrastructure_manager', 'member'] as const).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </Select>
      )}
      {type === 'governance_change' && (
        <div className="grid grid-cols-3 gap-2">
          <Input label="Quorum %" value={g.quorumPct} onChange={(e) => setG({ ...g, quorumPct: e.target.value })} />
          <Input label="Approval %" value={g.approvalPct} onChange={(e) => setG({ ...g, approvalPct: e.target.value })} />
          <Input label="Hours" value={g.votingHours} onChange={(e) => setG({ ...g, votingHours: e.target.value })} />
        </div>
      )}
      <Button type="submit" variant="primary" disabled={!ok}>Open vote</Button>
    </form>
  );
}

function Member({ s }: { s: SettlementData }) {
  const me = game.use((st) => st.me)!;
  const role = s.myRole!;
  const [invite, setInvite] = useState('');
  const [donate, setDonate] = useState('');
  const myParcels = useApi<{ parcels: { id: string; buildings: number }[] }>('/api/parcels/mine', ['wallet', 'settlement']);
  const treasury = useApi<{ entries: { id: number; type: string; amount: number; at: string; incoming: boolean; actor: string | null }[] }>(`/api/settlements/${s.id}/treasury`, ['settlement']);
  const now = useNow(5000);
  const act = async (fn: () => Promise<unknown>, msg: string) => { if (await run(fn, msg)) { bump('settlement'); refreshMe(); } };

  return (
    <>
      <Section title={s.name} actions={<Badge tone="violet">{s.tier.name}</Badge>}>
        {s.description && <p className="mb-2 text-sm text-fog-300">{s.description}</p>}
        <Row label="Your role">{ROLE_LABELS[role]}</Row>
        <Row label="Treasury"><Credits value={s.treasury} /></Row>
        <Row label="Members">{s.members.length} / {s.tier.memberCap}</Row>
        <Row label="Voting rules">{s.governance.quorumPct}% quorum · &gt;{s.governance.approvalPct}% yes · {s.governance.votingHours}h</Row>
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" onClick={() => flyTo(s.lng, s.lat, 16)}>Go to settlement</Button>
          {role !== 'founder' && <Button variant="danger" onClick={() => act(() => apiPost(`/api/settlements/${s.id}/leave`), 'You left the settlement')}>Leave</Button>}
        </div>
      </Section>

      <Section title="Proposals & votes">
        {s.proposals.length === 0 && <Empty>No proposals yet.</Empty>}
        <ul className="space-y-2">
          {s.proposals.map((p) => {
            const left = Math.max(0, Math.round((new Date(p.closesAt).getTime() - now) / 60000));
            return (
              <li key={p.id} className="rounded-lg border border-ink-700 p-3" data-testid={`proposal-${p.id}`}>
                <div className="flex items-center justify-between"><span className="text-sm font-medium">{p.title}</span><Badge tone={p.status === 'open' ? 'warn' : p.status === 'executed' ? 'accent' : 'neutral'}>{p.status}</Badge></div>
                <p className="text-xs text-fog-400">{p.type.replace(/_/g, ' ')} · by {p.proposedBy}{p.status === 'open' && ` · closes in ${left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m` : `${left}m`}`}</p>
                <p className="mt-1 text-xs text-fog-300">Yes {p.yes} · No {p.no} · Abstain {p.abstain} · {p.eligible} eligible (quorum {p.quorumPct}%)</p>
                {p.result?.note && <p className="text-xs text-fog-400">{p.result.note}</p>}
                {p.status === 'open' && (p.myVote ? <p className="mt-1 text-xs text-accent">You voted {p.myVote}.</p> : p.canVote ? (
                  <div className="mt-2 flex gap-2">
                    {(['yes', 'no', 'abstain'] as const).map((c) => <Button key={c} variant={c === 'yes' ? 'primary' : 'secondary'} onClick={() => act(() => apiPost(`/api/proposals/${p.id}/vote`, { choice: c }), `Voted ${c}`)}>{c}</Button>)}
                  </div>
                ) : <p className="mt-1 text-xs text-fog-400">You joined after this vote opened and are not eligible.</p>)}
              </li>
            );
          })}
        </ul>
        {hasPermission(role, 'start_votes') ? <div className="mt-3"><NewProposal s={s} /></div> : <p className="mt-2 text-xs text-fog-400">Your role cannot open votes.</p>}
      </Section>

      <Section title="Projects">
        {s.projects.length === 0 && <Empty>No projects yet.</Empty>}
        <ul className="space-y-2">{s.projects.map((p) => <ProjectCard key={p.id} p={p} s={s} />)}</ul>
        {hasPermission(role, 'propose_projects') && <div className="mt-3"><NewProject s={s} /></div>}
      </Section>

      <Section title="Members">
        <ul className="space-y-1">
          {s.members.map((m) => {
            const canManage = hasPermission(role, 'manage_members') && ROLE_RANK[role] > ROLE_RANK[m.role] && m.userId !== me.id;
            const canRole = hasPermission(role, 'manage_roles') && ROLE_RANK[role] > ROLE_RANK[m.role] && m.userId !== me.id;
            return (
              <li key={m.userId} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm">
                <span>{m.name} <span className="text-xs text-fog-400">Lv {m.level}</span></span>
                <span className="flex items-center gap-1">
                  {canRole ? (
                    <select aria-label={`Role of ${m.name}`} className="rounded border border-ink-600 bg-ink-850 px-1 py-0.5 text-xs" value={m.role} onChange={(e) => act(() => apiPost(`/api/settlements/${s.id}/members/${m.userId}/role`, { role: e.target.value }), 'Role updated')}>
                      {(['leader', 'treasurer', 'infrastructure_manager', 'member'] as const).filter((r) => ROLE_RANK[r] < ROLE_RANK[role] || r === m.role).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  ) : <Badge>{ROLE_LABELS[m.role]}</Badge>}
                  {canManage && <Button variant="ghost" className="px-1.5 py-0.5 text-xs" onClick={() => act(() => apiPost(`/api/settlements/${s.id}/members/${m.userId}/remove`), `${m.name} removed`)}>Remove</Button>}
                </span>
              </li>
            );
          })}
        </ul>
        {hasPermission(role, 'invite') && (
          <form className="mt-3 flex items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (/^[A-Za-z0-9_]{3,24}$/.test(invite)) { await act(() => apiPost(`/api/settlements/${s.id}/invites`, { username: invite }), `Invitation sent to ${invite}`); setInvite(''); } }}>
            <div className="flex-1"><Input label="Invite by username" value={invite} onChange={(e) => setInvite(e.target.value)} error={invite && !/^[A-Za-z0-9_]{3,24}$/.test(invite) ? 'Invalid username' : null} data-testid="invite-username" /></div>
            <Button type="submit" disabled={!invite}>Invite</Button>
          </form>
        )}
        {s.invites.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-fog-300">
            {s.invites.map((i) => (
              <li key={i.id} className="flex justify-between"><span>Pending: {i.invitee}</span><button className="text-fog-400 hover:text-danger" onClick={() => act(() => apiPost(`/api/invites/${i.id}/revoke`), 'Invitation revoked')}>Revoke</button></li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Settlement land">
        {s.parcels.length === 0 && <Empty>No settlement land.</Empty>}
        <ul className="space-y-1">
          {s.parcels.map((p) => <li key={p.id}><button className="flex w-full justify-between rounded-md px-2 py-1 text-sm hover:bg-ink-800" onClick={() => { flyTo(p.lng, p.lat, 17); game.set({ panel: 'world', selection: { kind: 'parcel', id: p.id } }); }}><span className="font-mono text-xs">#{p.id}</span><span className="text-xs text-fog-400">{p.buildings} structures</span></button></li>)}
        </ul>
        {hasPermission(role, 'contribute') && (
          <form className="mt-2 flex items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (donate) { await act(() => apiPost(`/api/settlements/${s.id}/parcels`, { parcelId: donate }), 'Parcel donated to the settlement'); setDonate(''); } }}>
            <div className="flex-1">
              <Select label="Donate an empty parcel" value={donate} onChange={(e) => setDonate(e.target.value)}>
                <option value="">Choose…</option>
                {myParcels.data?.parcels.filter((p) => p.buildings === 0).map((p) => <option key={p.id} value={p.id}>#{p.id}</option>)}
              </Select>
            </div>
            <Button type="submit" disabled={!donate}>Donate</Button>
          </form>
        )}
      </Section>

      <Section title="Treasury history">
        {treasury.error && <ErrorBox message={treasury.error} onRetry={treasury.reload} />}
        {treasury.data?.entries.length === 0 && <Empty>No treasury transactions.</Empty>}
        <ul className="space-y-1 text-xs">
          {treasury.data?.entries.map((t) => (
            <li key={t.id} className="flex justify-between"><span className="text-fog-300">{t.type.replace(/_/g, ' ')}{t.actor && ` · ${t.actor}`}</span><span className={`font-mono ${t.incoming ? 'text-accent' : ''}`}>{t.incoming ? '+' : '−'}{formatCredits(t.amount)}</span></li>
          ))}
        </ul>
      </Section>

      <Section title="Activity">
        <ul className="space-y-1 text-xs text-fog-300">
          {s.activity.map((a) => (
            <li key={a.id} className="flex justify-between gap-2"><span>{a.actor ?? 'System'}: {a.type.replace(/_/g, ' ')}{typeof a.payload.name === 'string' ? ` · ${a.payload.name}` : typeof a.payload.title === 'string' ? ` · ${a.payload.title}` : ''}</span><span className="shrink-0 text-fog-400">{timeAgo(a.at)}</span></li>
          ))}
        </ul>
      </Section>
    </>
  );
}

export default function SettlementsPanel() {
  const me = game.use((s) => s.me)!;
  const sid = me.settlement?.id ?? null;
  const data = useApi<SettlementData>(sid ? `/api/settlements/${sid}` : null, ['settlement']);
  if (!sid) return <NoSettlement />;
  if (data.loading && !data.data) return <Section title="Settlement"><Loading /></Section>;
  if (data.error) return <Section title="Settlement"><ErrorBox message={data.error} onRetry={data.reload} /></Section>;
  if (!data.data) return null;
  return <Member s={data.data} />;
}
