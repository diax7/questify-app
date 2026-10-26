import { z } from "zod";
import { itemSchema } from "#src/players/items";
import { achievementTierSchema } from "#src/questify/achievements";

const bilingual = z.object({ ar: z.string(), en: z.string() });

/** What a Questify quest counts (ADR-278): a closed list, so configuration never downloads a feature. */
export const QUESTIFY_METRICS = ["events", "cities", "quests"] as const;
export type QuestifyMetric = (typeof QUESTIFY_METRICS)[number];

/** A level reached for the first time, its title and the level items it gave (the completion answer's shape). */
export const levelUpSchema = z.object({
  level: z.number().int().min(2),
  title: bilingual,
  items: z.array(itemSchema),
});

/** What one `POST /v1/me/questify/sync` wrote: the new tiers, the Questify quests paid, the highest level reached. */
export const questifySyncSchema = z.object({
  achievements: z.array(z.object({ id: z.string().min(1).max(64), tier: achievementTierSchema })),
  quests: z.array(z.object({ id: z.uuid(), title: bilingual, xp: z.number().int().positive() })),
  levelUp: levelUpSchema.nullable(),
});
export type QuestifySync = z.infer<typeof questifySyncSchema>;

/** One Questify quest as its player sees it; a seasonal quest's progress counts inside its campaign's window. */
export const questifyQuestSchema = z.object({
  id: z.uuid(),
  title: bilingual,
  metric: z.enum(QUESTIFY_METRICS),
  target: z.number().int().positive(),
  progress: z.number().int().nonnegative(),
  xp: z.number().int().positive(),
  done: z.boolean(),
});
export type QuestifyQuest = z.infer<typeof questifyQuestSchema>;

/** `GET /v1/me/questify-quests`: always-on quests, then each campaign running now. */
export const questifyQuestsSchema = z.object({
  alwaysOn: z.array(questifyQuestSchema),
  seasonal: z.array(
    z.object({
      campaign: z.object({ id: z.uuid(), name: bilingual, endsAt: z.string() }),
      quests: z.array(questifyQuestSchema),
    }),
  ),
});
export type QuestifyQuests = z.infer<typeof questifyQuestsSchema>;

// Names and titles show to every player: control, line-separator and bidi embedding, override or isolate characters
// would reorder or break the line around them (the tables refuse them too).
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const label = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !FORBIDDEN.test(value), "must hold no control or direction characters");
const labels = z.strictObject({ ar: label, en: label });
const instant = z.iso.datetime({ offset: true });

/** A campaign as the console writes it: the window entered in Saudi time and sent with its offset. */
export const campaignBodySchema = z.strictObject({
  name: labels,
  startsAt: instant,
  endsAt: instant,
});
export type CampaignBody = z.infer<typeof campaignBodySchema>;

/** A quest as the console changes it; its campaign is chosen when it is created and never moves. */
export const questPatchSchema = z.strictObject({
  metric: z.enum(QUESTIFY_METRICS),
  target: z.number().int().min(1).max(1000),
  title: labels,
  xp: z.number().int().min(1).max(10000),
  position: z.number().int().min(1).max(1000),
  status: z.enum(["draft", "active"]),
});
export type QuestPatch = z.infer<typeof questPatchSchema>;
export const questBodySchema = questPatchSchema.extend({ campaignId: z.uuid().nullable() });
export type QuestBody = z.infer<typeof questBodySchema>;

const stamp = z.string();
/** A campaign in the console. */
export const adminCampaignSchema = z.object({
  id: z.uuid(),
  name: bilingual,
  startsAt: stamp,
  endsAt: stamp,
  status: z.enum(["draft", "published", "retired"]),
  createdAt: stamp,
  updatedAt: stamp,
});
/** A quest in the console. */
export const adminQuestSchema = z.object({
  id: z.uuid(),
  campaignId: z.uuid().nullable(),
  metric: z.enum(QUESTIFY_METRICS),
  target: z.number().int(),
  title: bilingual,
  xp: z.number().int(),
  position: z.number().int(),
  status: z.enum(["draft", "active", "retired"]),
  createdAt: stamp,
  updatedAt: stamp,
});
/** `GET /v1/admin/questify`: every always-on quest and the 100 latest-starting campaigns with their quests. */
export const adminQuestifySchema = z.object({
  alwaysOn: z.array(adminQuestSchema),
  campaigns: z.array(adminCampaignSchema.extend({ quests: z.array(adminQuestSchema) })),
});
export type AdminCampaign = z.infer<typeof adminCampaignSchema>;
export type AdminQuest = z.infer<typeof adminQuestSchema>;
export type AdminQuestify = z.infer<typeof adminQuestifySchema>;
