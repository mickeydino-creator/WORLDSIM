export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function xpForLevel(level: number): number {
  return 100 * (level - 1) ** 2;
}

export const XP = {
  parcelPurchase: 50,
  buildBase: 25,
  buildPer1000Credits: 2,
  trade: 15,
  research: 20,
  contributionPer1000Credits: 5,
  settlementFounded: 100,
};

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  metric: 'parcels' | 'buildings' | 'production_runs' | 'trades' | 'settlement_founded' | 'contributed_credits' | 'techs';
  threshold: number;
  reward: { researchPoints?: number; reputation?: number };
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_parcel', name: 'Landholder', description: 'Purchase your first parcel.', metric: 'parcels', threshold: 1, reward: { researchPoints: 3 } },
  { id: 'estate', name: 'Estate', description: 'Own 5 parcels.', metric: 'parcels', threshold: 5, reward: { researchPoints: 5, reputation: 5 } },
  { id: 'first_building', name: 'Groundbreaking', description: 'Construct your first building.', metric: 'buildings', threshold: 1, reward: { researchPoints: 3 } },
  { id: 'builder', name: 'Master builder', description: 'Construct 10 buildings.', metric: 'buildings', threshold: 10, reward: { researchPoints: 10, reputation: 5 } },
  { id: 'first_production', name: 'Open for business', description: 'Complete a production run.', metric: 'production_runs', threshold: 1, reward: { researchPoints: 2 } },
  { id: 'industrialist', name: 'Industrialist', description: 'Complete 25 production runs.', metric: 'production_runs', threshold: 25, reward: { researchPoints: 10 } },
  { id: 'first_trade', name: 'Trader', description: 'Complete a marketplace trade.', metric: 'trades', threshold: 1, reward: { researchPoints: 3 } },
  { id: 'merchant', name: 'Merchant', description: 'Complete 20 trades.', metric: 'trades', threshold: 20, reward: { researchPoints: 10, reputation: 5 } },
  { id: 'founder', name: 'Founder', description: 'Found a settlement.', metric: 'settlement_founded', threshold: 1, reward: { reputation: 10 } },
  { id: 'patron', name: 'Patron', description: 'Contribute 10,000 CR to settlement projects.', metric: 'contributed_credits', threshold: 10_000_00, reward: { reputation: 20 } },
  { id: 'scholar', name: 'Scholar', description: 'Research 5 technologies.', metric: 'techs', threshold: 5, reward: { reputation: 5 } },
];
