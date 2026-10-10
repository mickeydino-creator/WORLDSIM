import type { LandClass } from '@/shared/config/land';
import type { Modifiers } from '@/shared/config/research';
import type { ResourceId } from '@/shared/config/resources';

export interface Me {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  xp: number;
  level: number;
  reputation: number;
  researchPoints: number;
  specialization: string | null;
  home: [number, number] | null;
  balance: number;
  techs: string[];
  achievements: { id: string; unlockedAt: string }[];
  settlement: { id: string; name: string; role: string } | null;
  parcelCount: number;
  buildingCount: number;
  maxParcels: number;
  unreadNotifications: number;
  modifiers: Modifiers;
}

export interface BuildingSummary {
  id: string;
  type: string;
  parcelId: string;
  lng: number;
  lat: number;
  rotation: number;
  level: number;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
  settlementId: string | null;
}

export interface ParcelOwner { id: string; ownerId: string | null; ownerName: string | null; settlementId: string | null; settlementName: string | null }

export interface Chunk {
  key: string;
  cells: Record<string, LandClass>;
  parcels: ParcelOwner[];
  buildings: BuildingSummary[];
}

export interface Inventory { items: Record<ResourceId, number>; capacity: number }

export type Panel = 'world' | 'build' | 'economy' | 'settlements' | 'research' | 'profile' | 'settings';

export type Selection = { kind: 'parcel'; id: string } | { kind: 'building'; id: string } | null;

export interface Placement {
  type: string;
  rotation: number;
  lngLat: [number, number] | null;
  parcelId: string | null;
  valid: boolean;
  reason: string | null;
  /** When set, placement is choosing a site for a settlement project rather than building directly. */
  projectFor?: { settlementId: string; projectType: string; name: string };
}

export interface Notification { id: number; type: string; title: string; body: string; readAt: string | null; at: string }
