export type LandClass = 'land' | 'coastal' | 'urban' | 'water' | 'restricted';

export const LAND_CLASSES: Record<LandClass, { name: string; purchasable: boolean; basePrice: number; description: string }> = {
  land: { name: 'Open land', purchasable: true, basePrice: 1_500_00, description: 'Rural land suited to farms and industry.' },
  coastal: { name: 'Coastal land', purchasable: true, basePrice: 2_500_00, description: 'Land touching a coastline or lakeshore.' },
  urban: { name: 'Urban land', purchasable: true, basePrice: 4_000_00, description: 'Inside a real-world urban area. Agriculture is not permitted.' },
  water: { name: 'Water', purchasable: false, basePrice: 0, description: 'Sea, lake or river surface. Cannot be owned.' },
  restricted: { name: 'Restricted', purchasable: false, basePrice: 0, description: 'Protected zone. Cannot be owned or built on.' },
};

/** Each owned parcel within NEIGHBOR_RADIUS_M raises the price by this fraction (capped). */
export const NEIGHBOR_RADIUS_M = 500;
export const NEIGHBOR_PRICE_STEP = 0.04;
export const NEIGHBOR_PRICE_CAP = 1.0;

/** Authoritative land price (minor units). Only ever evaluated on the server. */
export function landPrice(cls: LandClass, ownedNeighbors: number): number {
  const base = LAND_CLASSES[cls].basePrice;
  const demand = Math.min(NEIGHBOR_PRICE_CAP, ownedNeighbors * NEIGHBOR_PRICE_STEP);
  return Math.round(base * (1 + demand));
}
