import { z } from "zod";
import type { MessageKey } from "#src/i18n/messages";
import { imageIdSchema } from "#src/images/images";
import { optionalPlainText } from "#src/text/plain-text";

/**
 * Sponsors (T-507, FR-1301 to FR-1305, FR-1307, ADR-375): profiles an owner or editor keeps for an event (a name, a tier
 * and a booth) and tags to quests, categories and rewards, which the app then shows as "presented by". A sponsor has no
 * login, no link and no access to player data (FR-1304): nothing in these types carries a contact detail or a player.
 * A souvenir can be tagged too (T-507c): its owner sees "presented by" on it in their locker and recap.
 * The logo and the banner are uploads and come with T-507b. These types and checks are shared by the dashboard, the API
 * and the app; the database checks every field again.
 */

/** The tiers, in the order the strip lists them. */
export const SPONSOR_TIERS = ["platinum", "gold", "silver", "bronze", "partner"] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

const TIER_KEYS: Readonly<Record<SponsorTier, MessageKey>> = {
  platinum: "sponsors.tier.platinum",
  gold: "sponsors.tier.gold",
  silver: "sponsors.tier.silver",
  bronze: "sponsors.tier.bronze",
  partner: "sponsors.tier.partner",
};

/** The words for a tier (the dashboard's choice and its badge). */
export const tierKey = (tier: SponsorTier): MessageKey => TIER_KEYS[tier];

/** What a sponsor's tag can name (the team's side). A souvenir shows its sponsor to its owner only (T-507c). */
export const SPONSOR_TAG_KINDS = ["quest", "category", "reward", "souvenir"] as const;
export type SponsorTagKind = (typeof SPONSOR_TAG_KINDS)[number];

/** What a player's app is told about an event's items: a souvenir tag is never listed there (ADR-570). */
export const MEMBER_TAG_KINDS = ["quest", "category", "reward"] as const;
export type MemberTagKind = (typeof MEMBER_TAG_KINDS)[number];

/** Limits the database repeats. */
export const SPONSOR_LIMITS = { name: 60, booth: 40, sponsors: 100 } as const;

/** `POST …/sponsors`, `PUT …/sponsors/{id}`: a name in one language is enough, as a map's is. */
export const sponsorBodySchema = z
  .strictObject({
    nameAr: optionalPlainText(SPONSOR_LIMITS.name),
    nameEn: optionalPlainText(SPONSOR_LIMITS.name),
    tier: z.enum(SPONSOR_TIERS),
    booth: optionalPlainText(SPONSOR_LIMITS.booth),
    /** The logo and the strip banner (T-507b): left out keeps them, null removes them, an image id sets them. */
    logo: imageIdSchema.nullable().optional(),
    banner: imageIdSchema.nullable().optional(),
  })
  .superRefine((body, context) => {
    if ((body.nameAr ?? "") === "" && (body.nameEn ?? "") === "") {
      context.addIssue({ code: "custom", path: ["name"], message: "name" });
    }
  });
export type SponsorBody = z.input<typeof sponsorBodySchema>;

/** `PUT …/sponsor-tags`: tag an item to a sponsor, or take its sponsor away (`sponsorId` null). */
export const sponsorTagBodySchema = z.strictObject({
  kind: z.enum(SPONSOR_TAG_KINDS),
  targetId: z.uuid(),
  sponsorId: z.uuid().nullable(),
});
export type SponsorTagBody = z.input<typeof sponsorTagBodySchema>;

const teamTagSchema = z.object({ kind: z.enum(SPONSOR_TAG_KINDS), targetId: z.uuid() });
export type TeamSponsorTag = z.infer<typeof teamTagSchema>;

/** A sponsor as the dashboard lists it with its tags (`sponsor_team_item`). */
export const teamSponsorSchema = z.object({
  id: z.uuid(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  tier: z.enum(SPONSOR_TIERS),
  booth: z.string().nullable(),
  logo: z.string().nullish(),
  banner: z.string().nullish(),
  tags: z.array(teamTagSchema),
});
export type TeamSponsor = z.infer<typeof teamSponsorSchema>;

/** `GET …/sponsors` for the dashboard, in the strip's order. */
export const teamSponsorListSchema = z.object({ sponsors: z.array(teamSponsorSchema) });

const bilingual = z.object({ ar: z.string(), en: z.string() });

/**
 * The sponsor that presents a souvenir, as the souvenir's owner sees it in their own locker and recap (T-507c, FR-1303):
 * the name and the tier that rings the mark, nothing else. It is on those two private answers only; no public item
 * (equipment, public profile, ranking) carries it.
 */
export const presentedBySchema = z.object({
  name: bilingual,
  tier: z.enum(SPONSOR_TIERS),
  /** The sponsor's logo (T-507b), read through its event's image door; without it the lettered mark shows. */
  logo: z.string().nullish(),
  eventId: z.string().nullish(),
});
export type PresentedBySponsor = z.infer<typeof presentedBySchema>;

/** A sponsor as the app shows it. */
export const memberSponsorSchema = z.object({
  id: z.uuid(),
  name: bilingual,
  tier: z.enum(SPONSOR_TIERS),
  booth: z.string().nullable(),
  /** The logo and the banner ids (T-507b); without a logo the app keeps the lettered mark. */
  logo: z.string().nullish(),
  banner: z.string().nullish(),
});
export type MemberSponsor = z.infer<typeof memberSponsorSchema>;

/** A tag on an item the player may see: the item and its sponsor, nothing else. */
export const memberSponsorTagSchema = z.object({
  kind: z.enum(MEMBER_TAG_KINDS),
  targetId: z.uuid(),
  sponsorId: z.uuid(),
});
export type MemberSponsorTag = z.infer<typeof memberSponsorTagSchema>;

/** `GET /v1/events/{id}/sponsors`: the sponsors in the strip's order and the tags on what the player may see. */
export const memberSponsorsSchema = z.object({
  sponsors: z.array(memberSponsorSchema),
  tags: z.array(memberSponsorTagSchema),
});
export type MemberSponsors = z.infer<typeof memberSponsorsSchema>;
