import { z } from 'zod';
import { FOLLOWER_HOURS } from './followers.js';

const id = z.string().regex(/^\d{1,24}$/);
export const followersRequestSchema = z.discriminatedUnion('action', [
  z.object({ type: z.literal('followers'), action: z.literal('scan'), hours: z.number().refine((v) => (FOLLOWER_HOURS as readonly number[]).includes(v)) }).strict(),
  z.object({ type: z.literal('followers'), action: z.literal('state'), scanId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('followers'), action: z.literal('generate'), scanId: z.string().uuid(), fanId: id }).strict(),
  z.object({ type: z.literal('followers'), action: z.literal('send'), scanId: z.string().uuid(), fanId: id, historyRevision: z.string().uuid(), text: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ type: z.literal('followers'), action: z.literal('close') }).strict(),
]);
export type FollowersRequest = z.infer<typeof followersRequestSchema>;
