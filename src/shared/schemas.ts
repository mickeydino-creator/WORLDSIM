// Request schemas shared by API routes (server-side validation) and client forms.
import { z } from 'zod';

const MAX_MINOR = 1_000_000_000_00; // 1 billion credits

export const registerSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,24}$/, '3-24 letters, digits or underscores'),
  email: z.string().trim().email('Enter a valid email').max(254),
  password: z.string().min(10, 'At least 10 characters').max(200),
  displayName: z.string().trim().min(1).max(40),
});

export const loginSchema = z.object({
  username: z.string().min(1).max(254),
  password: z.string().min(1).max(200),
});

export const purchaseSchema = z.object({
  maxPrice: z.number().int().positive().max(MAX_MINOR).optional(),
});

export const permissionSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,24}$/),
  grant: z.boolean(),
});

export const placeBuildingSchema = z.object({
  type: z.string().min(1).max(40),
  parcelId: z.string().regex(/^\d+_\d+$/),
  lng: z.number().gte(-180).lte(180),
  lat: z.number().gte(-90).lte(90),
  rotation: z.number().gte(0).lt(360),
});

export const productionSchema = z.object({
  recipeId: z.string().min(1).max(40),
  autoRepeat: z.boolean().default(false),
});

export const autoRepeatSchema = z.object({ autoRepeat: z.boolean() });

export const orderSchema = z.object({
  side: z.enum(['buy', 'sell']),
  resource: z.string().min(1).max(20),
  pricePerUnit: z.number().int().positive().max(MAX_MINOR),
  quantity: z.number().int().positive().max(1_000_000),
  expiresHours: z.number().int().min(1).max(168).default(24),
});

export const takeOrderSchema = z.object({ quantity: z.number().int().positive().max(1_000_000) });

export const specializationSchema = z.object({ specialization: z.string().min(1).max(30) });

export const createSettlementSchema = z.object({
  name: z.string().trim().min(3).max(40),
  description: z.string().trim().max(500).default(''),
  parcelId: z.string().regex(/^\d+_\d+$/).optional(),
});

export const inviteSchema = z.object({ username: z.string().regex(/^[A-Za-z0-9_]{3,24}$/, 'Enter a valid username') });
export const respondInviteSchema = z.object({ accept: z.boolean() });
export const roleSchema = z.object({ role: z.enum(['leader', 'treasurer', 'infrastructure_manager', 'member']) });
export const donateParcelSchema = z.object({ parcelId: z.string().regex(/^\d+_\d+$/) });

export const projectSchema = z.object({
  type: z.string().min(1).max(40),
  name: z.string().trim().min(3).max(60),
  parcelId: z.string().regex(/^\d+_\d+$/).optional(),
  lng: z.number().gte(-180).lte(180).optional(),
  lat: z.number().gte(-90).lte(90).optional(),
  rotation: z.number().gte(0).lt(360).optional(),
  targetBuildingId: z.string().uuid().optional(),
});

export const contributeSchema = z.object({
  currency: z.number().int().positive().max(MAX_MINOR).optional(),
  resources: z.record(z.string(), z.number().int().positive().max(1_000_000)).optional(),
  fromTreasury: z.boolean().default(false),
});

export const proposalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('treasury_transfer'), title: z.string().trim().min(3).max(80), payload: z.object({ toUserId: z.string().uuid(), amount: z.number().int().positive().max(MAX_MINOR) }) }),
  z.object({ type: z.literal('role_change'), title: z.string().trim().min(3).max(80), payload: z.object({ userId: z.string().uuid(), role: z.enum(['leader', 'treasurer', 'infrastructure_manager', 'member']) }) }),
  z.object({ type: z.literal('remove_member'), title: z.string().trim().min(3).max(80), payload: z.object({ userId: z.string().uuid() }) }),
  z.object({ type: z.literal('governance_change'), title: z.string().trim().min(3).max(80), payload: z.object({ quorumPct: z.number().int().min(1).max(100), approvalPct: z.number().int().min(50).max(100), votingHours: z.number().int().min(1).max(168) }) }),
]);

export const voteSchema = z.object({ choice: z.enum(['yes', 'no', 'abstain']) });

export const markReadSchema = z.object({ ids: z.array(z.number().int().positive()).max(200).optional() });

export const displayNameSchema = z.object({ displayName: z.string().trim().min(1).max(40) });
export const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10).max(200) });

export const adminGrantSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,24}$/),
  amount: z.number().int().positive().max(MAX_MINOR),
  reason: z.string().trim().min(3).max(200),
});
