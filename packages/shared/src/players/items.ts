import { z } from "zod";
import { publicAchievementSchema } from "#src/questify/achievements";
import { publicStampSchema } from "#src/questify/events";

export const ITEM_KINDS = ["character", "frame", "title"] as const;
export const itemSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(ITEM_KINDS),
  name: z.object({ ar: z.string().min(1).max(60), en: z.string().min(1).max(60) }),
  visualKey: z.string().max(40).nullable(),
});
export type ProfileItem = z.infer<typeof itemSchema>;
export const equipmentSchema = z.object({
  character: itemSchema.nullable(),
  frame: itemSchema.nullable(),
  title: itemSchema.nullable(),
});
export type Equipment = z.infer<typeof equipmentSchema>;
export const EMPTY_EQUIPMENT: Equipment = { character: null, frame: null, title: null };
export const profilePatchSchema = z
  .strictObject({
    username: z.string().min(1).max(120).optional(),
    avatar: z.enum(["falcon", "fox", "camel", "owl", "lantern", "explorer-hat"]).optional(),
    characterId: z.string().min(1).max(64).nullable().optional(),
    frameId: z.string().min(1).max(64).nullable().optional(),
    titleId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
  .refine((value) => value.avatar === undefined || value.characterId === undefined);
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export const lockerEntrySchema = z.object({
  item: itemSchema,
  earnedAt: z.string(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("level"), level: z.number().int().positive() }),
    z.object({
      kind: z.literal("event"),
      event: z.object({ id: z.uuid(), name: z.object({ ar: z.string(), en: z.string() }) }),
    }),
  ]),
  seen: z.boolean(),
});
export type LockerEntry = z.infer<typeof lockerEntrySchema>;
export const lockerSchema = z.object({
  items: z.array(lockerEntrySchema),
  nextCursor: z.string().nullable(),
});
export const publicProfileSchema = z.object({
  username: z.string(),
  character: itemSchema.or(z.object({ starter: z.string() })),
  frame: itemSchema.nullable(),
  title: itemSchema.nullable(),
  level: z.object({
    number: z.number().int().positive(),
    title: z.object({ ar: z.string(), en: z.string() }),
  }),
  /** All five, tiers only (T-403). */
  achievements: z.array(publicAchievementSchema),
  /** At most 50 stamps of ended public events (ADR-276). */
  passport: z.array(publicStampSchema).max(50),
});
export type PublicProfile = z.infer<typeof publicProfileSchema>;
