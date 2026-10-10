// Building catalog. All gameplay behaviour is data-driven from this table: costs, requirements,
// footprints, effects and the stylised 3D model. There is no per-building special-case logic.
import type { ResourceId } from './resources';
import type { LandClass } from './land';

export type BuildingCategory = 'residential' | 'commercial' | 'industrial' | 'agriculture' | 'public' | 'infrastructure';

/** A primitive of the low-poly model. Local metres: x = east, y = up, z = north, origin = footprint centre at ground. */
export interface ModelPart {
  s: 'box' | 'cyl' | 'roof' | 'cone';
  w: number; // width (x) or diameter for cyl/cone
  h: number;
  d: number; // depth (z); ignored for cyl/cone
  x?: number;
  y?: number; // base height
  z?: number;
  c: string; // colour
}

export interface BuildingDef {
  type: string;
  name: string;
  category: BuildingCategory;
  description: string;
  width: number; // metres
  depth: number;
  height: number;
  cost: number; // minor units
  resources: Partial<Record<ResourceId, number>>;
  requirements: {
    minLevel?: number;
    research?: string[];
    landClasses?: LandClass[];
    settlementLandOnly?: boolean;
    requiresOwned?: string[];
  };
  maxLevel: number;
  /** Upgrade to level L costs cost * upgradeCostFactor * (L-1), plus resources scaled the same way. */
  upgradeCostFactor: number;
  effects: {
    incomePerHour?: number; // minor units at level 1, +50% per extra level
    researchPerHour?: number;
    reputationPerHour?: number;
    storage?: number; // extra capacity per resource, per level
    population?: number;
    recipes?: string[];
  };
  model: ModelPart[];
}

const ALL_LAND: LandClass[] = ['land', 'coastal', 'urban'];
const RURAL: LandClass[] = ['land', 'coastal'];
const CR = 100;

// Palette for the stylised look.
const P = {
  wall: '#e9e4da',
  wall2: '#d8d2c4',
  brick: '#b8664e',
  roof: '#8c3b2f',
  roof2: '#4d5866',
  glass: '#7fb0c9',
  concrete: '#b9bcc1',
  steel: '#7b8794',
  dark: '#3d4450',
  green: '#6aa84f',
  green2: '#4f8a3a',
  field: '#c9b458',
  soil: '#8a6a45',
  water: '#4f97c7',
  asphalt: '#4a4d52',
  stripe: '#e8e2c8',
  wood: '#9b6b43',
  gold: '#d9a441',
};

export const BUILDINGS: BuildingDef[] = [
  // ---------------- Residential ----------------
  {
    type: 'small_house', name: 'Small house', category: 'residential',
    description: 'A family home. Generates rent for its owner.',
    width: 12, depth: 10, height: 8, cost: 2_000 * CR, resources: { wood: 20 },
    requirements: { landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.6,
    effects: { incomePerHour: 120 * CR, population: 4 },
    model: [
      { s: 'box', w: 10, h: 4.5, d: 8, c: P.wall },
      { s: 'roof', w: 11, h: 3, d: 9, y: 4.5, c: P.roof },
      { s: 'box', w: 1.2, h: 2.2, d: 0.3, z: -4.1, c: P.wood },
    ],
  },
  {
    type: 'apartment_building', name: 'Apartment building', category: 'residential',
    description: 'Mid-rise housing with higher rent yield.',
    width: 22, depth: 16, height: 24, cost: 12_000 * CR, resources: { wood: 60, stone: 80 },
    requirements: { minLevel: 3, research: ['urban_planning'], landClasses: ALL_LAND, requiresOwned: ['water_facility'] },
    maxLevel: 4, upgradeCostFactor: 0.5,
    effects: { incomePerHour: 650 * CR, population: 30 },
    model: [
      { s: 'box', w: 20, h: 22, d: 14, c: P.wall2 },
      { s: 'box', w: 20.4, h: 0.6, d: 14.4, y: 22, c: P.dark },
      { s: 'box', w: 20.2, h: 1.2, d: 14.2, y: 6, c: P.glass },
      { s: 'box', w: 20.2, h: 1.2, d: 14.2, y: 12, c: P.glass },
      { s: 'box', w: 20.2, h: 1.2, d: 14.2, y: 18, c: P.glass },
    ],
  },
  {
    type: 'residential_complex', name: 'Residential complex', category: 'residential',
    description: 'Dense towers around a courtyard.',
    width: 40, depth: 32, height: 46, cost: 40_000 * CR, resources: { stone: 200, metal: 80 },
    requirements: { minLevel: 6, research: ['high_density'], landClasses: ALL_LAND, requiresOwned: ['water_facility'] },
    maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { incomePerHour: 2_400 * CR, population: 120 },
    model: [
      { s: 'box', w: 14, h: 44, d: 14, x: -12, z: 7, c: P.wall2 },
      { s: 'box', w: 14, h: 32, d: 14, x: 12, z: -7, c: P.wall },
      { s: 'box', w: 30, h: 10, d: 10, x: 0, z: -9, c: P.wall2 },
      { s: 'box', w: 14.3, h: 1, d: 14.3, x: -12, y: 44, z: 7, c: P.dark },
      { s: 'box', w: 10, h: 0.3, d: 12, x: 8, z: 9, c: P.green },
    ],
  },
  // ---------------- Commercial ----------------
  {
    type: 'shop', name: 'Shop', category: 'commercial',
    description: 'Sells manufactured goods to residents for credits.',
    width: 12, depth: 10, height: 6, cost: 5_000 * CR, resources: { wood: 30 },
    requirements: { landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.6,
    effects: { recipes: ['shop_sales'] },
    model: [
      { s: 'box', w: 11, h: 5, d: 9, c: P.wall },
      { s: 'box', w: 11.4, h: 0.6, d: 9.4, y: 5, c: P.dark },
      { s: 'box', w: 9, h: 2.4, d: 0.3, z: -4.6, y: 0.4, c: P.glass },
      { s: 'box', w: 11, h: 0.4, d: 2, z: -5.2, y: 3.2, c: '#c0504d' },
    ],
  },
  {
    type: 'restaurant', name: 'Restaurant', category: 'commercial',
    description: 'Turns agricultural goods into meals sold for credits.',
    width: 16, depth: 12, height: 7, cost: 8_000 * CR, resources: { wood: 40, stone: 20 },
    requirements: { minLevel: 2, research: ['commerce'], landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.6,
    effects: { recipes: ['restaurant_meals'] },
    model: [
      { s: 'box', w: 15, h: 5, d: 11, c: P.brick },
      { s: 'roof', w: 16, h: 2.5, d: 12, y: 5, c: P.roof2 },
      { s: 'box', w: 12, h: 2.2, d: 0.3, z: -5.6, y: 0.6, c: P.glass },
      { s: 'cyl', w: 1.2, h: 3, d: 1.2, x: 5, y: 5, z: 2, c: P.dark },
    ],
  },
  {
    type: 'shopping_center', name: 'Shopping center', category: 'commercial',
    description: 'Large retail hub with high sales throughput.',
    width: 60, depth: 44, height: 14, cost: 50_000 * CR, resources: { stone: 250, metal: 120, wood: 80 },
    requirements: { minLevel: 5, research: ['retail_networks'], landClasses: ['urban', 'land', 'coastal'] },
    maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { recipes: ['mall_sales'] },
    model: [
      { s: 'box', w: 58, h: 12, d: 42, c: P.concrete },
      { s: 'box', w: 58.4, h: 0.8, d: 42.4, y: 12, c: P.dark },
      { s: 'box', w: 20, h: 6, d: 0.4, z: -21.2, y: 1, c: P.glass },
      { s: 'cyl', w: 12, h: 4, d: 12, y: 12.8, c: P.glass },
    ],
  },
  // ---------------- Industrial ----------------
  {
    type: 'lumber_camp', name: 'Lumber camp', category: 'industrial',
    description: 'Harvests wood from surrounding forest.',
    width: 16, depth: 14, height: 7, cost: 2_500 * CR, resources: {},
    requirements: { landClasses: RURAL }, maxLevel: 3, upgradeCostFactor: 0.6,
    effects: { recipes: ['harvest_wood'] },
    model: [
      { s: 'box', w: 8, h: 4, d: 6, x: -3, c: P.wood },
      { s: 'roof', w: 9, h: 2, d: 7, x: -3, y: 4, c: P.roof2 },
      { s: 'cyl', w: 1.2, h: 6, d: 1.2, x: 4, z: 3, c: P.wood },
      { s: 'cyl', w: 1.2, h: 6, d: 1.2, x: 5.6, z: 3, c: P.wood },
      { s: 'cone', w: 5, h: 8, d: 5, x: 5, z: -4, c: P.green2 },
    ],
  },
  {
    type: 'quarry', name: 'Quarry', category: 'industrial',
    description: 'Extracts stone; with Mining research also metal ore.',
    width: 24, depth: 20, height: 6, cost: 3_500 * CR, resources: { wood: 20 },
    requirements: { landClasses: RURAL }, maxLevel: 3, upgradeCostFactor: 0.6,
    effects: { recipes: ['quarry_stone', 'quarry_ore'] },
    model: [
      { s: 'box', w: 22, h: 1, d: 18, c: '#8d8478' },
      { s: 'box', w: 8, h: 3, d: 6, x: -6, y: 1, z: 4, c: P.concrete },
      { s: 'box', w: 6, h: 2, d: 6, x: 6, y: 1, z: -4, c: '#a39a8c' },
      { s: 'box', w: 2, h: 6, d: 2, x: 0, y: 1, z: 0, c: P.steel },
    ],
  },
  {
    type: 'warehouse', name: 'Warehouse', category: 'industrial',
    description: 'Increases storage capacity for every resource.',
    width: 24, depth: 16, height: 9, cost: 6_000 * CR, resources: { wood: 40, stone: 30 },
    requirements: { landClasses: ALL_LAND }, maxLevel: 5, upgradeCostFactor: 0.5,
    effects: { storage: 1_000 },
    model: [
      { s: 'box', w: 23, h: 7, d: 15, c: P.concrete },
      { s: 'roof', w: 24, h: 2, d: 16, y: 7, c: P.steel },
      { s: 'box', w: 5, h: 4.5, d: 0.3, z: -7.6, c: P.dark },
    ],
  },
  {
    type: 'processing_facility', name: 'Processing facility', category: 'industrial',
    description: 'Smelts stone ore into metal using energy.',
    width: 26, depth: 20, height: 16, cost: 15_000 * CR, resources: { stone: 80, wood: 40 },
    requirements: { minLevel: 2, research: ['mining'], landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { recipes: ['smelt_metal'] },
    model: [
      { s: 'box', w: 20, h: 9, d: 18, x: -2, c: P.steel },
      { s: 'cyl', w: 6, h: 12, d: 6, x: 9, z: 4, c: P.concrete },
      { s: 'cyl', w: 1.4, h: 16, d: 1.4, x: -8, z: -5, c: P.dark },
      { s: 'box', w: 20.4, h: 0.5, d: 18.4, x: -2, y: 9, c: P.dark },
    ],
  },
  {
    type: 'factory', name: 'Factory', category: 'industrial',
    description: 'Combines metal, wood and energy into manufactured goods.',
    width: 34, depth: 24, height: 18, cost: 25_000 * CR, resources: { stone: 120, metal: 60 },
    requirements: { minLevel: 4, research: ['industrialization'], landClasses: ALL_LAND, requiresOwned: ['power_facility'] },
    maxLevel: 4, upgradeCostFactor: 0.5,
    effects: { recipes: ['manufacture_goods'] },
    model: [
      { s: 'box', w: 32, h: 10, d: 22, c: P.brick },
      { s: 'roof', w: 10.5, h: 3, d: 22, x: -10.7, y: 10, c: P.steel },
      { s: 'roof', w: 10.5, h: 3, d: 22, x: 0, y: 10, c: P.steel },
      { s: 'roof', w: 10.5, h: 3, d: 22, x: 10.7, y: 10, c: P.steel },
      { s: 'cyl', w: 2, h: 18, d: 2, x: 13, z: 8, c: P.dark },
    ],
  },
  // ---------------- Agriculture ----------------
  {
    type: 'field', name: 'Field', category: 'agriculture',
    description: 'Cheap open cropland.',
    width: 30, depth: 30, height: 1, cost: 800 * CR, resources: {},
    requirements: { landClasses: RURAL }, maxLevel: 3, upgradeCostFactor: 0.6,
    effects: { recipes: ['field_crops'] },
    model: [
      { s: 'box', w: 30, h: 0.3, d: 30, c: P.soil },
      { s: 'box', w: 28, h: 0.6, d: 5, z: -10, c: P.field },
      { s: 'box', w: 28, h: 0.6, d: 5, z: -3.5, c: P.field },
      { s: 'box', w: 28, h: 0.6, d: 5, z: 3, c: P.green },
      { s: 'box', w: 28, h: 0.6, d: 5, z: 9.5, c: P.field },
    ],
  },
  {
    type: 'farm', name: 'Farm', category: 'agriculture',
    description: 'Farmhouse with barn and crops.',
    width: 36, depth: 30, height: 9, cost: 3_000 * CR, resources: { wood: 30 },
    requirements: { landClasses: RURAL }, maxLevel: 4, upgradeCostFactor: 0.6,
    effects: { recipes: ['farm_crops'], population: 3 },
    model: [
      { s: 'box', w: 36, h: 0.3, d: 30, c: P.soil },
      { s: 'box', w: 20, h: 0.6, d: 26, x: 7, c: P.field },
      { s: 'box', w: 9, h: 5, d: 8, x: -12, z: 6, c: '#a8432f' },
      { s: 'roof', w: 10, h: 3.5, d: 9, x: -12, y: 5, z: 6, c: P.dark },
      { s: 'cyl', w: 4, h: 9, d: 4, x: -12, z: -6, c: P.concrete },
    ],
  },
  {
    type: 'greenhouse', name: 'Greenhouse', category: 'agriculture',
    description: 'Energy-assisted, high-yield crops.',
    width: 24, depth: 14, height: 6, cost: 9_000 * CR, resources: { metal: 30, wood: 20 },
    requirements: { minLevel: 3, research: ['hydroponics'], landClasses: ALL_LAND, requiresOwned: ['water_facility'] },
    maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { recipes: ['greenhouse_crops'] },
    model: [
      { s: 'box', w: 23, h: 3.5, d: 13, c: '#a9d4c8' },
      { s: 'roof', w: 23.4, h: 2.5, d: 13.4, y: 3.5, c: '#c7e6dc' },
      { s: 'box', w: 21, h: 0.8, d: 11, y: 0.2, c: P.green },
    ],
  },
  // ---------------- Public ----------------
  {
    type: 'park', name: 'Park', category: 'public',
    description: 'Green space that builds reputation.',
    width: 24, depth: 24, height: 7, cost: 1_500 * CR, resources: {},
    requirements: { landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.6,
    effects: { reputationPerHour: 2 },
    model: [
      { s: 'box', w: 24, h: 0.3, d: 24, c: P.green },
      { s: 'box', w: 2.5, h: 0.35, d: 24, c: '#d6ccb0' },
      { s: 'cone', w: 5, h: 7, d: 5, x: -7, z: 6, c: P.green2 },
      { s: 'cone', w: 4, h: 6, d: 4, x: 7, z: -6, c: P.green2 },
      { s: 'cone', w: 4.5, h: 6.5, d: 4.5, x: 7, z: 7, c: '#5d9b45' },
      { s: 'cyl', w: 4, h: 0.6, d: 4, x: -6, z: -7, c: P.water },
    ],
  },
  {
    type: 'school', name: 'School', category: 'public',
    description: 'Produces research points over time.',
    width: 30, depth: 20, height: 10, cost: 10_000 * CR, resources: { wood: 60, stone: 40 },
    requirements: { minLevel: 2, landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { researchPerHour: 6, reputationPerHour: 1 },
    model: [
      { s: 'box', w: 28, h: 8, d: 12, z: 3, c: '#e0c9a6' },
      { s: 'box', w: 28.4, h: 0.5, d: 12.4, y: 8, z: 3, c: P.roof },
      { s: 'box', w: 10, h: 0.2, d: 6, z: -6, c: P.asphalt },
      { s: 'cyl', w: 0.3, h: 8, d: 0.3, x: 6, z: -6, c: P.steel },
    ],
  },
  {
    type: 'clinic', name: 'Clinic', category: 'public',
    description: 'Healthcare that raises reputation substantially.',
    width: 22, depth: 16, height: 9, cost: 12_000 * CR, resources: { stone: 60, metal: 20 },
    requirements: { minLevel: 3, research: ['public_services'], landClasses: ALL_LAND, requiresOwned: ['water_facility'] },
    maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { reputationPerHour: 5 },
    model: [
      { s: 'box', w: 20, h: 8, d: 14, c: '#f2f2f0' },
      { s: 'box', w: 20.4, h: 0.5, d: 14.4, y: 8, c: P.dark },
      { s: 'box', w: 4, h: 1.2, d: 0.3, y: 6, z: -7.2, c: '#c0392b' },
      { s: 'box', w: 1.2, h: 4, d: 0.3, y: 4.6, z: -7.2, c: '#c0392b' },
    ],
  },
  {
    type: 'town_hall', name: 'Town hall', category: 'public',
    description: 'Civic seat of a settlement. Earns income into the settlement treasury.',
    width: 30, depth: 24, height: 20, cost: 30_000 * CR, resources: { stone: 150, wood: 80 },
    requirements: { minLevel: 3, research: ['civic_leadership'], landClasses: ALL_LAND, settlementLandOnly: true },
    maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { incomePerHour: 900 * CR, reputationPerHour: 4 },
    model: [
      { s: 'box', w: 28, h: 10, d: 18, c: '#e8dcc2' },
      { s: 'roof', w: 29, h: 4, d: 19, y: 10, c: P.roof2 },
      { s: 'box', w: 6, h: 6, d: 6, y: 10, c: '#e8dcc2' },
      { s: 'cone', w: 5, h: 5, d: 5, y: 16, c: P.gold },
      { s: 'box', w: 14, h: 1, d: 4, z: -10, c: P.concrete },
    ],
  },
  // ---------------- Infrastructure ----------------
  {
    type: 'road', name: 'Road segment', category: 'infrastructure',
    description: 'A 40 m paved segment. Roads may be placed end to end.',
    width: 8, depth: 40, height: 0.4, cost: 200 * CR, resources: { stone: 5 },
    requirements: { landClasses: ALL_LAND }, maxLevel: 1, upgradeCostFactor: 1,
    effects: {},
    model: [
      { s: 'box', w: 8, h: 0.25, d: 40, c: P.asphalt },
      { s: 'box', w: 0.3, h: 0.3, d: 6, z: -12, c: P.stripe },
      { s: 'box', w: 0.3, h: 0.3, d: 6, z: 0, c: P.stripe },
      { s: 'box', w: 0.3, h: 0.3, d: 6, z: 12, c: P.stripe },
    ],
  },
  {
    type: 'power_facility', name: 'Power facility', category: 'infrastructure',
    description: 'Burns wood to generate energy.',
    width: 24, depth: 20, height: 22, cost: 14_000 * CR, resources: { stone: 60, wood: 30 },
    requirements: { minLevel: 2, landClasses: ALL_LAND }, maxLevel: 4, upgradeCostFactor: 0.5,
    effects: { recipes: ['generate_energy'] },
    model: [
      { s: 'box', w: 14, h: 8, d: 12, x: -4, c: P.concrete },
      { s: 'cyl', w: 7, h: 18, d: 7, x: 7, z: 4, c: '#cfd3d8' },
      { s: 'cyl', w: 1.5, h: 22, d: 1.5, x: -8, z: -4, c: '#a33' },
      { s: 'box', w: 6, h: 3, d: 4, x: 6, z: -6, c: P.gold },
    ],
  },
  {
    type: 'water_facility', name: 'Water facility', category: 'infrastructure',
    description: 'Utility required by dense housing, greenhouses and clinics.',
    width: 22, depth: 22, height: 14, cost: 10_000 * CR, resources: { stone: 50, metal: 10 },
    requirements: { minLevel: 2, landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { reputationPerHour: 1 },
    model: [
      { s: 'cyl', w: 14, h: 3, d: 14, x: -3, z: 3, c: P.concrete },
      { s: 'cyl', w: 12.5, h: 3.2, d: 12.5, x: -3, z: 3, c: P.water },
      { s: 'cyl', w: 5, h: 12, d: 5, x: 7, z: -6, c: '#dfe3e8' },
      { s: 'cone', w: 5.4, h: 2, d: 5.4, x: 7, y: 12, z: -6, c: P.steel },
    ],
  },
  {
    type: 'transport_station', name: 'Transport station', category: 'infrastructure',
    description: 'Logistics hub: increases storage and lowers market fees.',
    width: 40, depth: 18, height: 10, cost: 18_000 * CR, resources: { stone: 100, metal: 40 },
    requirements: { minLevel: 4, research: ['logistics'], landClasses: ALL_LAND }, maxLevel: 3, upgradeCostFactor: 0.5,
    effects: { storage: 500 },
    model: [
      { s: 'box', w: 38, h: 0.8, d: 16, c: P.concrete },
      { s: 'box', w: 12, h: 7, d: 10, x: -12, y: 0.8, c: '#d8d2c4' },
      { s: 'roof', w: 36, h: 2.5, d: 8, y: 6, z: 2, c: P.steel },
      { s: 'box', w: 36, h: 0.3, d: 2, y: 0.8, z: -5, c: P.dark },
    ],
  },
];

export const BUILDINGS_BY_TYPE: Record<string, BuildingDef> = Object.fromEntries(BUILDINGS.map((b) => [b.type, b]));

export function getBuildingDef(type: string): BuildingDef | undefined {
  return Object.prototype.hasOwnProperty.call(BUILDINGS_BY_TYPE, type) ? BUILDINGS_BY_TYPE[type] : undefined;
}

export const CATEGORY_LABELS: Record<BuildingCategory, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  industrial: 'Industrial',
  agriculture: 'Agriculture',
  public: 'Public',
  infrastructure: 'Infrastructure',
};

export const CATEGORY_COLORS: Record<BuildingCategory, string> = {
  residential: '#d7cfc0',
  commercial: '#c98d5a',
  industrial: '#8d97a3',
  agriculture: '#8fbf5a',
  public: '#7fb3a6',
  infrastructure: '#9b9fa6',
};

/** Income multiplier for a building level. */
export function levelMultiplier(level: number): number {
  return 1 + 0.5 * (level - 1);
}

export function upgradeCost(def: BuildingDef, toLevel: number): { cost: number; resources: Partial<Record<ResourceId, number>> } {
  const f = def.upgradeCostFactor * (toLevel - 1);
  const resources: Partial<Record<ResourceId, number>> = {};
  for (const [r, q] of Object.entries(def.resources)) resources[r as ResourceId] = Math.ceil((q ?? 0) * f);
  return { cost: Math.ceil(def.cost * f), resources };
}

/** Fraction of the build cost refunded on demolition. */
export const DEMOLISH_REFUND = 0.25;
