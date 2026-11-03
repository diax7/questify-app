import { z } from "zod";
import { cleanAnnouncementText } from "#src/announcements/announcements";
import { textIssue, type InvitationNameIssue } from "#src/invitation-campaigns/name-rule";
import { templateIssues, type TemplateIssueCode } from "#src/messaging/templates";

/**
 * A push to a group of players (T-706b, FR-1777, ADR-531): a platform admin sends one text, in Arabic and English, to
 * everyone in an event, or to the players who opted in to promotional push, optionally in one city or holding any of a
 * few interests. The text is the promotional push's: a title of at most 60 and a text of at most 140 characters, each
 * language in its own script, no placeholder (a push never carries personal data), and the announcements' filter for an
 * address or a phone number. The console, the API and the tests use these functions; the database door checks the
 * structure again.
 */

export const GROUP_PUSH_TITLE_MAX = 60;
export const GROUP_PUSH_BODY_MAX = 140;
/** The most interests a send can name (a player holds at most 8). */
export const GROUP_PUSH_INTERESTS_MAX = 8;
/** The preview counts players up to this many and says "more than" beyond it. */
export const GROUP_PUSH_REACH_CAP = 100_000;

export const GROUP_PUSH_AUDIENCES = ["event", "promo"] as const;
export type GroupPushAudienceKind = (typeof GROUP_PUSH_AUDIENCES)[number];

const text = z.string().max(1000);
const pair = z.strictObject({ ar: text, en: text });

/** The audience: an event named by its join code, or opted-in players (a city and interests narrow them). */
export const groupPushAudienceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("event"),
    joinCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{4,12}$/),
  }),
  z.strictObject({
    kind: z.literal("promo"),
    cityId: z
      .string()
      .regex(/^sa-[a-z0-9-]{2,30}$/)
      .nullable(),
    interests: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{1,29}$/))
      .max(GROUP_PUSH_INTERESTS_MAX)
      .refine((list) => new Set(list).size === list.length, "no repeats"),
  }),
]);
export type GroupPushAudience = z.infer<typeof groupPushAudienceSchema>;

/** What `POST /v1/admin/group-pushes` and its preview take. */
export const groupPushBodySchema = z.strictObject({
  audience: groupPushAudienceSchema,
  title: pair,
  body: pair,
});
export type GroupPushBody = z.infer<typeof groupPushBodySchema>;

export type GroupPushText = Pick<GroupPushBody, "title" | "body">;
export type GroupPushIssueCode = TemplateIssueCode | InvitationNameIssue;
export type GroupPushIssue = Readonly<{ path: string; message: GroupPushIssueCode }>;

export type GroupPushCheck =
  | Readonly<{ ok: true; text: GroupPushText }>
  | Readonly<{ ok: false; issues: readonly GroupPushIssue[] }>;

const FIELDS = [
  ["title", "ar"],
  ["title", "en"],
  ["body", "ar"],
  ["body", "en"],
] as const;

/**
 * Cleans the four fields the way announcements are (invisible characters out, one space between words, Western digits)
 * and checks each: the promotional push's template rules (both languages written, in their own script, within 60 and
 * 140 characters, no placeholder) and the name rule (no address, phone number or control character). On success the
 * cleaned text is what is sent; otherwise every issue names its field (`title.ar`).
 */
export function checkGroupPushText(raw: GroupPushText): GroupPushCheck {
  const clean: GroupPushText = {
    title: {
      ar: cleanAnnouncementText(raw.title.ar),
      en: cleanAnnouncementText(raw.title.en),
    },
    body: { ar: cleanAnnouncementText(raw.body.ar), en: cleanAnnouncementText(raw.body.en) },
  };
  const issues: GroupPushIssue[] = [...templateIssues("promo_push", clean)];
  for (const [part, language] of FIELDS) {
    const found = textIssue(clean[part][language]);
    if (found !== null) issues.push({ path: `${part}.${language}`, message: found });
  }
  return issues.length === 0 ? { ok: true, text: clean } : { ok: false, issues };
}

const named = z.strictObject({ ar: z.string(), en: z.string() });
/** An event may be named in one language only. */
const eventNamed = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });
const eventName = z.strictObject({ id: z.uuid(), joinCode: z.string(), name: eventNamed });

/** One send as the console lists it. */
export const groupPushViewSchema = z.strictObject({
  id: z.uuid(),
  audience: z.enum(GROUP_PUSH_AUDIENCES),
  event: eventName.nullable(),
  cityId: z.string().nullable(),
  interests: z.array(z.string()),
  title: named,
  body: named,
  state: z.enum(["sending", "done"]),
  reach: z.number().int().nonnegative(),
  notices: z.number().int().nonnegative(),
  capped: z.number().int().nonnegative(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type GroupPushView = z.infer<typeof groupPushViewSchema>;

export const groupPushListSchema = z.strictObject({ pushes: z.array(groupPushViewSchema) });
export const groupPushSentSchema = z.strictObject({ push: groupPushViewSchema });

/** What the preview answers: who the send would reach, before it is sent. */
export const groupPushPreviewSchema = z.strictObject({
  audience: z.enum(GROUP_PUSH_AUDIENCES),
  event: eventName.extend({ status: z.string() }).nullable(),
  cityId: z.string().nullable(),
  interests: z.array(z.string()),
  reach: z.number().int().nonnegative(),
  /** True when the count stopped at the cap: "more than 100,000". */
  capped: z.boolean(),
});
export type GroupPushPreview = z.infer<typeof groupPushPreviewSchema>;
export const groupPushPreviewAnswerSchema = z.strictObject({ preview: groupPushPreviewSchema });
