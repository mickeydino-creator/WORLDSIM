import type { ResourceId } from './resources';

export interface RecipeDef {
  id: string;
  name: string;
  building: string;
  inputs: Partial<Record<ResourceId, number>>;
  outputs: Partial<Record<ResourceId, number>>;
  /** Credits (minor units) minted to the owner on completion, e.g. retail sales to residents. */
  currencyOut?: number;
  durationSec: number;
  /** Credits (minor units) charged when the run starts (wages, upkeep). */
  operatingCost: number;
  research?: string[];
  xp: number;
}

export const RECIPES: RecipeDef[] = [
  { id: 'harvest_wood', name: 'Harvest timber', building: 'lumber_camp', inputs: {}, outputs: { wood: 12 }, durationSec: 60, operatingCost: 20_00, xp: 8 },
  { id: 'quarry_stone', name: 'Cut stone', building: 'quarry', inputs: {}, outputs: { stone: 10 }, durationSec: 60, operatingCost: 25_00, xp: 8 },
  { id: 'quarry_ore', name: 'Mine ore', building: 'quarry', inputs: { energy: 2 }, outputs: { metal: 2 }, durationSec: 120, operatingCost: 40_00, research: ['mining'], xp: 12 },
  { id: 'field_crops', name: 'Grow crops', building: 'field', inputs: {}, outputs: { agri: 6 }, durationSec: 60, operatingCost: 10_00, xp: 6 },
  { id: 'farm_crops', name: 'Farm harvest', building: 'farm', inputs: {}, outputs: { agri: 14 }, durationSec: 90, operatingCost: 25_00, xp: 10 },
  { id: 'greenhouse_crops', name: 'Hydroponic harvest', building: 'greenhouse', inputs: { energy: 2 }, outputs: { agri: 30 }, durationSec: 90, operatingCost: 30_00, xp: 12 },
  { id: 'generate_energy', name: 'Generate power', building: 'power_facility', inputs: { wood: 4 }, outputs: { energy: 20 }, durationSec: 60, operatingCost: 30_00, xp: 10 },
  { id: 'smelt_metal', name: 'Smelt metal', building: 'processing_facility', inputs: { stone: 6, energy: 3 }, outputs: { metal: 4 }, durationSec: 90, operatingCost: 50_00, xp: 14 },
  { id: 'manufacture_goods', name: 'Manufacture goods', building: 'factory', inputs: { metal: 2, wood: 4, energy: 4 }, outputs: { goods: 3 }, durationSec: 120, operatingCost: 80_00, xp: 20 },
  { id: 'shop_sales', name: 'Retail sales', building: 'shop', inputs: { goods: 1 }, outputs: {}, currencyOut: 420_00, durationSec: 60, operatingCost: 15_00, xp: 10 },
  { id: 'restaurant_meals', name: 'Serve meals', building: 'restaurant', inputs: { agri: 6, energy: 1 }, outputs: {}, currencyOut: 260_00, durationSec: 60, operatingCost: 20_00, xp: 10 },
  { id: 'mall_sales', name: 'Mall sales', building: 'shopping_center', inputs: { goods: 5 }, outputs: {}, currencyOut: 2_600_00, durationSec: 120, operatingCost: 120_00, xp: 30 },
];

export const RECIPES_BY_ID: Record<string, RecipeDef> = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

export function getRecipe(id: string): RecipeDef | undefined {
  return Object.prototype.hasOwnProperty.call(RECIPES_BY_ID, id) ? RECIPES_BY_ID[id] : undefined;
}

/** Research points granted per completed production run. */
export const RP_PER_RUN = 1;
