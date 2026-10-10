export type SettlementRole = 'founder' | 'leader' | 'treasurer' | 'infrastructure_manager' | 'member';

export type SettlementPermission =
  | 'invite'
  | 'manage_members'
  | 'manage_roles'
  | 'propose_projects'
  | 'approve_spending'
  | 'manage_assets'
  | 'start_votes'
  | 'vote'
  | 'contribute'
  | 'build_on_land';

export const ROLE_PERMISSIONS: Record<SettlementRole, SettlementPermission[]> = {
  founder: ['invite', 'manage_members', 'manage_roles', 'propose_projects', 'approve_spending', 'manage_assets', 'start_votes', 'vote', 'contribute', 'build_on_land'],
  leader: ['invite', 'manage_members', 'manage_roles', 'propose_projects', 'approve_spending', 'manage_assets', 'start_votes', 'vote', 'contribute', 'build_on_land'],
  treasurer: ['invite', 'propose_projects', 'approve_spending', 'start_votes', 'vote', 'contribute'],
  infrastructure_manager: ['invite', 'propose_projects', 'manage_assets', 'start_votes', 'vote', 'contribute', 'build_on_land'],
  member: ['propose_projects', 'vote', 'contribute'],
};

/** Higher rank can manage lower rank. */
export const ROLE_RANK: Record<SettlementRole, number> = { founder: 4, leader: 3, treasurer: 2, infrastructure_manager: 2, member: 1 };

export const ROLE_LABELS: Record<SettlementRole, string> = {
  founder: 'Founder',
  leader: 'Leader',
  treasurer: 'Treasurer',
  infrastructure_manager: 'Infrastructure manager',
  member: 'Member',
};

export function hasPermission(role: SettlementRole, p: SettlementPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(p);
}

export const SETTLEMENT_FOUNDING_COST = 5_000_00;
export const SETTLEMENT_MIN_LEVEL = 2;

export interface ProjectTypeDef {
  type: string;
  name: string;
  description: string;
  /** Building created when the project completes (unless upgradeExisting). */
  building?: string;
  upgradeExisting?: boolean;
  costMultiplier: number; // relative to the building cost
}

export const PROJECT_TYPES: ProjectTypeDef[] = [
  { type: 'public_park', name: 'Public park', description: 'Builds a park on settlement land.', building: 'park', costMultiplier: 1.5 },
  { type: 'road_connection', name: 'Road connection', description: 'Paves a road segment on settlement land.', building: 'road', costMultiplier: 1.5 },
  { type: 'community_building', name: 'Community building', description: 'Builds a town hall that earns treasury income.', building: 'town_hall', costMultiplier: 1 },
  { type: 'infrastructure_upgrade', name: 'Infrastructure upgrade', description: 'Upgrades an existing settlement-owned building by one level.', upgradeExisting: true, costMultiplier: 1.2 },
];

export function getProjectType(t: string): ProjectTypeDef | undefined {
  return PROJECT_TYPES.find((p) => p.type === t);
}

export const DEFAULT_GOVERNANCE = { quorumPct: 50, approvalPct: 50, votingHours: 24 };

/**
 * Proposal passes when turnout (yes+no+abstain)/eligible >= quorum and
 * yes/(yes+no) > approval threshold (strictly greater for 50%).
 */
export function tallyPasses(yes: number, no: number, abstain: number, eligible: number, quorumPct: number, approvalPct: number): { quorumMet: boolean; passed: boolean } {
  const turnout = yes + no + abstain;
  const quorumMet = eligible > 0 && turnout * 100 >= quorumPct * eligible;
  const decisive = yes + no;
  const approved = decisive > 0 && yes * 100 > approvalPct * decisive;
  return { quorumMet, passed: quorumMet && approved };
}

export interface SettlementTier { name: string; minMembers: number; minProjects: number; memberCap: number }
export const SETTLEMENT_TIERS: SettlementTier[] = [
  { name: 'Outpost', minMembers: 1, minProjects: 0, memberCap: 8 },
  { name: 'Village', minMembers: 3, minProjects: 1, memberCap: 20 },
  { name: 'Town', minMembers: 8, minProjects: 3, memberCap: 50 },
  { name: 'City', minMembers: 20, minProjects: 8, memberCap: 200 },
];

export function settlementTier(members: number, completedProjects: number): SettlementTier {
  let t = SETTLEMENT_TIERS[0];
  for (const tier of SETTLEMENT_TIERS) if (members >= tier.minMembers && completedProjects >= tier.minProjects) t = tier;
  return t;
}
