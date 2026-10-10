export const RESOURCES = {
  wood: { name: 'Wood', color: '#a47148' },
  stone: { name: 'Stone', color: '#9aa0a6' },
  metal: { name: 'Metal', color: '#7d8fa3' },
  agri: { name: 'Agricultural goods', color: '#8fbf5a' },
  goods: { name: 'Manufactured goods', color: '#d9a441' },
  energy: { name: 'Energy', color: '#e8d25a' },
} as const;

export type ResourceId = keyof typeof RESOURCES;
export const RESOURCE_IDS = Object.keys(RESOURCES) as ResourceId[];

export function isResourceId(x: string): x is ResourceId {
  return Object.prototype.hasOwnProperty.call(RESOURCES, x);
}

/** Base storage per resource before warehouses and research bonuses. */
export const BASE_STORAGE = 500;

/** Currency: integer minor units, 100 minor units = 1 credit. */
export const MINOR_PER_CREDIT = 100;
export const STARTING_BALANCE = 50_000 * MINOR_PER_CREDIT;
export const STARTING_RESOURCES: Partial<Record<ResourceId, number>> = { wood: 120, stone: 80 };
export const STARTING_RESEARCH_POINTS = 5;

export function formatCredits(minor: number | bigint | string): string {
  const v = typeof minor === 'bigint' ? minor : BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 100n;
  const cents = abs % 100n;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${w}${cents === 0n ? '' : '.' + cents.toString().padStart(2, '0')} CR`;
}
