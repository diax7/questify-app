import {
  adminQuestifySchema,
  campaignBodySchema,
  formatLocalDate,
  questBodySchema,
  questPatchSchema,
  toLocalInput,
  type AdminCampaign,
  type AdminQuest,
  type AdminQuestify,
  type CampaignBody,
  type Language,
  type MessageKey,
  type QuestBody,
  type QuestPatch,
} from "@questify/shared";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";

/** The console enters and shows every campaign time in Saudi time (Asia/Riyadh, no daylight saving; T-403 plan). */
export const SAUDI_ZONE = "Asia/Riyadh";
const SAUDI_OFFSET = "+03:00";

/** The page's answer; undefined when it is not the expected shape. */
export function readAdminQuestify(body: unknown): AdminQuestify | undefined {
  const parsed = adminQuestifySchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** A campaign as the form holds it: the window as the wall clock in Saudi time (what a date-time field shows). */
export type CampaignDraft = Readonly<{
  nameAr: string;
  nameEn: string;
  startsAt: string;
  endsAt: string;
}>;

export const BLANK_CAMPAIGN: CampaignDraft = { nameAr: "", nameEn: "", startsAt: "", endsAt: "" };

export const campaignDraftOf = (campaign: AdminCampaign): CampaignDraft => ({
  nameAr: campaign.name.ar,
  nameEn: campaign.name.en,
  startsAt: toLocalInput(new Date(campaign.startsAt), SAUDI_ZONE),
  endsAt: toLocalInput(new Date(campaign.endsAt), SAUDI_ZONE),
});

/** A quest as the form holds it; the numbers stay as typed until they are checked. */
export type QuestDraft = Readonly<{
  titleAr: string;
  titleEn: string;
  metric: QuestBody["metric"];
  target: string;
  xp: string;
  gems: string;
  position: string;
  status: QuestBody["status"];
}>;

export const BLANK_QUEST: QuestDraft = {
  titleAr: "",
  titleEn: "",
  metric: "events",
  target: "",
  xp: "",
  gems: "0",
  position: "1",
  status: "draft",
};

export const questDraftOf = (quest: AdminQuest): QuestDraft => ({
  titleAr: quest.title.ar,
  titleEn: quest.title.en,
  metric: quest.metric,
  target: String(quest.target),
  xp: String(quest.xp),
  gems: String(quest.gems),
  position: String(quest.position),
  // A retired quest has no form; the others are saved as a draft or active.
  status: quest.status === "active" ? "active" : "draft",
});

/** The API's field names, so a problem points at one thing. */
export type QuestifyField = "label" | "startsAt" | "endsAt" | "target" | "xp" | "gems" | "position";

export type Checked<T> =
  | Readonly<{ ok: true; body: T }>
  | Readonly<{ ok: false; field: QuestifyField | "other" }>;

const FIELD_OF: Readonly<Record<string, QuestifyField>> = {
  name: "label",
  title: "label",
  startsAt: "startsAt",
  endsAt: "endsAt",
  target: "target",
  xp: "xp",
  gems: "gems",
  position: "position",
};

const fieldOf = (path: ReadonlyArray<PropertyKey>): QuestifyField | "other" => {
  const first = path[0];
  return typeof first === "string" ? (FIELD_OF[first] ?? "other") : "other";
};

/** A wall-clock time in Saudi time as the instant the API takes: seconds added, the +03:00 offset sent. */
const instantOf = (local: string): string =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? `${local}:00${SAUDI_OFFSET}` : local;

/** Checks a campaign form with the schema the API uses, before anything is sent. */
export function campaignBodyOf(draft: CampaignDraft): Checked<CampaignBody> {
  const parsed = campaignBodySchema.safeParse({
    name: { ar: draft.nameAr, en: draft.nameEn },
    startsAt: instantOf(draft.startsAt),
    endsAt: instantOf(draft.endsAt),
  });
  if (!parsed.success) {
    return { ok: false, field: fieldOf(parsed.error.issues[0]?.path ?? []) };
  }
  const { startsAt, endsAt } = parsed.data;
  return Date.parse(endsAt) <= Date.parse(startsAt)
    ? { ok: false, field: "endsAt" }
    : { ok: true, body: parsed.data };
}

const WHOLE = /^\d{1,5}$/;

function questFields(draft: QuestDraft) {
  return {
    metric: draft.metric,
    target: WHOLE.test(draft.target.trim()) ? Number(draft.target) : Number.NaN,
    title: { ar: draft.titleAr, en: draft.titleEn },
    xp: WHOLE.test(draft.xp.trim()) ? Number(draft.xp) : Number.NaN,
    gems: WHOLE.test(draft.gems.trim()) ? Number(draft.gems) : Number.NaN,
    position: WHOLE.test(draft.position.trim()) ? Number(draft.position) : Number.NaN,
    status: draft.status,
  };
}

/**
 * Whether a quest can pay players now (an active quest, always-on or in a published campaign). Its gems are then fixed,
 * as its condition is: raising them later could never pay earlier awardees (ADR-286).
 */
export const questCanPay = (quest: AdminQuest, campaign: AdminCampaign | null): boolean =>
  quest.status === "active" && (campaign === null || campaign.status === "published");

/** Checks a new quest's form (its campaign, or none for an always-on quest, is chosen when it is created). */
export function questBodyOf(draft: QuestDraft, campaignId: string | null): Checked<QuestBody> {
  const parsed = questBodySchema.safeParse({ ...questFields(draft), campaignId });
  return parsed.success
    ? { ok: true, body: parsed.data }
    : { ok: false, field: fieldOf(parsed.error.issues[0]?.path ?? []) };
}

/** Checks an edited quest's form: its campaign never moves, so it is not part of the body. */
export function questPatchOf(draft: QuestDraft): Checked<QuestPatch> {
  const parsed = questPatchSchema.safeParse(questFields(draft));
  return parsed.success
    ? { ok: true, body: parsed.data }
    : { ok: false, field: fieldOf(parsed.error.issues[0]?.path ?? []) };
}

/** The message that says why a form was refused before it was sent. */
export const invalidKey = (field: QuestifyField | "other"): MessageKey =>
  `console.questify.invalid.${field}` as const;

const CONFLICT_KEYS: Readonly<Record<string, MessageKey>> = {
  retired: "console.questify.conflict.retired",
  start_passed: "console.questify.conflict.startPassed",
  started: "console.questify.conflict.started",
  ends_earlier: "console.questify.conflict.endsEarlier",
  ended: "console.questify.conflict.ended",
  frozen: "console.questify.conflict.frozen",
  too_many: "console.questify.conflict.tooMany",
  campaign_closed: "console.questify.conflict.campaignClosed",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The words for the API's Questify refusals: a 409 `questify_conflict {reason}` and a 422 `invalid_questify {field}`.
 * Any other answer, or a reason this page does not know, is undefined so the caller can show the API's own message.
 */
export function refusalKey(body: unknown): MessageKey | undefined {
  const details = isRecord(body) && isRecord(body["details"]) ? body["details"] : {};
  const code = errorCodeOf(body);
  if (code === "questify_conflict") {
    return CONFLICT_KEYS[String(details["reason"])] ?? "console.questify.conflict.other";
  }
  if (code === "invalid_questify") {
    const field = FIELD_OF[String(details["field"])];
    return invalidKey(field ?? "other");
  }
  return undefined;
}

/** A moment in Saudi time for people: "26 Oct 2026 09:00" (Western digits; the form labels say it is Saudi time). */
export function saudiStamp(iso: string, language: Language): string {
  const [date = "", time = ""] = toLocalInput(new Date(iso), SAUDI_ZONE).split("T");
  return `${formatLocalDate(date, language)} ${time}`;
}
