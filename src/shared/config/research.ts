// Research tree. Each node has explicit, mechanically enforced effects.
import type { BuildingCategory } from './buildings';

export type Specialization = 'construction' | 'trade' | 'agriculture' | 'industry' | 'infrastructure' | 'leadership';

export const SPECIALIZATIONS: Record<Specialization, { name: string; description: string }> = {
  construction: { name: 'Construction', description: '-10% construction cost; construction research costs 20% less.' },
  trade: { name: 'Trade', description: '-1% market fee; trade research costs 20% less.' },
  agriculture: { name: 'Agriculture', description: '+15% agricultural output; agriculture research costs 20% less.' },
  industry: { name: 'Industry', description: '+15% industrial output; industry research costs 20% less.' },
  infrastructure: { name: 'Infrastructure', description: '+25% storage; infrastructure research costs 20% less.' },
  leadership: { name: 'Community leadership', description: '+50% reputation gain; leadership research costs 20% less.' },
};

export interface TechEffects {
  unlockBuildings?: string[];
  unlockRecipes?: string[];
  buildCostMultiplier?: number; // multiplicative, e.g. 0.95
  outputMultiplier?: { categories: BuildingCategory[]; factor: number };
  durationMultiplier?: number;
  storageMultiplier?: number;
  marketFeeDelta?: number; // basis points, negative lowers fee
  incomeMultiplier?: number;
  reputationMultiplier?: number;
}

export interface TechDef {
  id: string;
  name: string;
  branch: Specialization;
  cost: number; // research points
  prereqs: string[];
  description: string;
  effects: TechEffects;
}

export const TECHS: TechDef[] = [
  { id: 'urban_planning', name: 'Urban planning', branch: 'construction', cost: 10, prereqs: [], description: 'Unlocks apartment buildings; -5% construction cost.', effects: { unlockBuildings: ['apartment_building'], buildCostMultiplier: 0.95 } },
  { id: 'high_density', name: 'High-density housing', branch: 'construction', cost: 30, prereqs: ['urban_planning'], description: 'Unlocks residential complexes; +10% rent.', effects: { unlockBuildings: ['residential_complex'], incomeMultiplier: 1.1 } },
  { id: 'commerce', name: 'Commerce', branch: 'trade', cost: 8, prereqs: [], description: 'Unlocks restaurants; -0.5% market fee.', effects: { unlockBuildings: ['restaurant'], marketFeeDelta: -50 } },
  { id: 'retail_networks', name: 'Retail networks', branch: 'trade', cost: 30, prereqs: ['commerce'], description: 'Unlocks shopping centers; -0.5% market fee.', effects: { unlockBuildings: ['shopping_center'], marketFeeDelta: -50 } },
  { id: 'crop_rotation', name: 'Crop rotation', branch: 'agriculture', cost: 10, prereqs: [], description: '+25% agricultural output.', effects: { outputMultiplier: { categories: ['agriculture'], factor: 1.25 } } },
  { id: 'hydroponics', name: 'Hydroponics', branch: 'agriculture', cost: 15, prereqs: ['crop_rotation'], description: 'Unlocks greenhouses.', effects: { unlockBuildings: ['greenhouse'] } },
  { id: 'mining', name: 'Mining', branch: 'industry', cost: 10, prereqs: [], description: 'Unlocks ore mining and processing facilities.', effects: { unlockBuildings: ['processing_facility'], unlockRecipes: ['quarry_ore'] } },
  { id: 'industrialization', name: 'Industrialization', branch: 'industry', cost: 25, prereqs: ['mining'], description: 'Unlocks factories.', effects: { unlockBuildings: ['factory'] } },
  { id: 'automation', name: 'Automation', branch: 'industry', cost: 40, prereqs: ['industrialization'], description: 'All production runs take 20% less time.', effects: { durationMultiplier: 0.8 } },
  { id: 'power_grid', name: 'Power grid', branch: 'infrastructure', cost: 12, prereqs: [], description: '+25% output from infrastructure (energy).', effects: { outputMultiplier: { categories: ['infrastructure'], factor: 1.25 } } },
  { id: 'logistics', name: 'Logistics', branch: 'infrastructure', cost: 20, prereqs: ['power_grid'], description: 'Unlocks transport stations; +50% storage.', effects: { unlockBuildings: ['transport_station'], storageMultiplier: 1.5 } },
  { id: 'civic_leadership', name: 'Civic leadership', branch: 'leadership', cost: 10, prereqs: [], description: 'Unlocks town halls; +20% reputation gain.', effects: { unlockBuildings: ['town_hall'], reputationMultiplier: 1.2 } },
  { id: 'public_services', name: 'Public services', branch: 'leadership', cost: 20, prereqs: ['civic_leadership'], description: 'Unlocks clinics.', effects: { unlockBuildings: ['clinic'] } },
];

export const TECHS_BY_ID: Record<string, TechDef> = Object.fromEntries(TECHS.map((t) => [t.id, t]));

export function getTech(id: string): TechDef | undefined {
  return Object.prototype.hasOwnProperty.call(TECHS_BY_ID, id) ? TECHS_BY_ID[id] : undefined;
}

export const SPECIALIZATION_RESEARCH_DISCOUNT = 0.8;
export const SPECIALIZATION_CHANGE_COST_RP = 25;

export function techCost(tech: TechDef, specialization: string | null): number {
  return specialization === tech.branch ? Math.ceil(tech.cost * SPECIALIZATION_RESEARCH_DISCOUNT) : tech.cost;
}

/** Aggregated modifiers for a player given unlocked techs and specialization. */
export interface Modifiers {
  buildCostMultiplier: number;
  outputMultiplier: Partial<Record<BuildingCategory, number>>;
  durationMultiplier: number;
  storageMultiplier: number;
  marketFeeBps: number;
  incomeMultiplier: number;
  reputationMultiplier: number;
}

export const BASE_MARKET_FEE_BPS = 200; // 2%

export function computeModifiers(techIds: Iterable<string>, specialization: string | null): Modifiers {
  const m: Modifiers = {
    buildCostMultiplier: 1,
    outputMultiplier: {},
    durationMultiplier: 1,
    storageMultiplier: 1,
    marketFeeBps: BASE_MARKET_FEE_BPS,
    incomeMultiplier: 1,
    reputationMultiplier: 1,
  };
  const mulOut = (cats: BuildingCategory[], f: number) => {
    for (const c of cats) m.outputMultiplier[c] = (m.outputMultiplier[c] ?? 1) * f;
  };
  for (const id of techIds) {
    const t = getTech(id);
    if (!t) continue;
    const e = t.effects;
    if (e.buildCostMultiplier) m.buildCostMultiplier *= e.buildCostMultiplier;
    if (e.outputMultiplier) mulOut(e.outputMultiplier.categories, e.outputMultiplier.factor);
    if (e.durationMultiplier) m.durationMultiplier *= e.durationMultiplier;
    if (e.storageMultiplier) m.storageMultiplier *= e.storageMultiplier;
    if (e.marketFeeDelta) m.marketFeeBps += e.marketFeeDelta;
    if (e.incomeMultiplier) m.incomeMultiplier *= e.incomeMultiplier;
    if (e.reputationMultiplier) m.reputationMultiplier *= e.reputationMultiplier;
  }
  switch (specialization) {
    case 'construction': m.buildCostMultiplier *= 0.9; break;
    case 'trade': m.marketFeeBps -= 100; break;
    case 'agriculture': mulOut(['agriculture'], 1.15); break;
    case 'industry': mulOut(['industrial'], 1.15); break;
    case 'infrastructure': m.storageMultiplier *= 1.25; break;
    case 'leadership': m.reputationMultiplier *= 1.5; break;
  }
  m.marketFeeBps = Math.max(0, m.marketFeeBps);
  return m;
}

/** Buildings available without research. Anything unlocked by a tech requires that tech. */
export function buildingRequiresTech(type: string): string | undefined {
  return TECHS.find((t) => t.effects.unlockBuildings?.includes(type))?.id;
}
