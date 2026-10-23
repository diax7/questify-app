import type { JoinOption, LocalizedText } from "@questify/shared";
import type { ApiResult, Client } from "#src/api/client.ts";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { PendingJoin } from "#src/auth/sign-in-flow.ts";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/**
 * A join field as the card shows it (FR-130); a kind this build does not know reads as a custom field. A choice field
 * (ADR-171) has options and its answer is one of their ids; null for a free-text answer.
 */
export type JoinField = Readonly<{
  id: string;
  kind: string;
  label: Text;
  required: boolean;
  options: readonly JoinOption[] | null;
}>;

/** What an event asks and checks at the join (T-212). An older API sends none of it: no fields, no locks. */
export type JoinRules = Readonly<{
  fields: readonly JoinField[];
  guestListOnly: boolean;
  emailDomains: readonly string[];
  welcomePoints: number | null;
}>;

const NO_RULES: JoinRules = {
  fields: [],
  guestListOnly: false,
  emailDomains: [],
  welcomePoints: null,
};

/** An event as its join card shows it (`GET /v1/public/events/{code}`, T-111). */
export type CardEvent = Readonly<{
  id: string;
  joinCode: string;
  name: Text;
  venue: Text;
  startsAt: string;
  endsAt: string;
  timezone: string;
  statusNow: "scheduled" | "live" | "ended";
  access: "public" | "unlisted" | "private";
  join: JoinRules;
}>;

/** An invited event (FR-133): the same card without a join code. */
export type InvitedEvent = Omit<CardEvent, "joinCode">;

export type JoinCard = Readonly<{
  version: string;
  title: LocalizedText;
  receives: readonly LocalizedText[];
}>;

export type CardAnswer =
  | Readonly<{ kind: "card"; event: CardEvent; card: JoinCard }>
  | Readonly<{ kind: "not_found" | "throttled" | "network" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLocalized = (value: unknown): value is LocalizedText =>
  isRecord(value) && typeof value["ar"] === "string" && typeof value["en"] === "string";

const isText = (value: unknown): value is Text =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

/** The join card's own fields: its version, the title and what the organizer will see, each in both languages. */
export function readJoinCard(card: unknown): JoinCard | undefined {
  if (
    !isRecord(card) ||
    typeof card["version"] !== "string" ||
    !isLocalized(card["title"]) ||
    !Array.isArray(card["receives"]) ||
    !card["receives"].every(isLocalized)
  ) {
    return undefined;
  }
  return {
    version: card["version"],
    title: card["title"],
    receives: card["receives"] as LocalizedText[],
  };
}

const isLabel = (value: unknown) =>
  value === undefined || value === null || typeof value === "string";

const isOption = (value: unknown): value is Partial<JoinOption> & { id: string } =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isLabel(value["ar"]) &&
  isLabel(value["en"]);

const isOptions = (value: unknown) =>
  value === undefined || value === null || (Array.isArray(value) && value.every(isOption));

const isField = (value: unknown): value is Omit<JoinField, "options"> & { options?: unknown } =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["kind"] === "string" &&
  isText(value["label"]) &&
  typeof value["required"] === "boolean" &&
  isOptions(value["options"]);

/** The event's join rules; absent is none (an older API), a wrong shape is undefined. */
export function readRules(value: unknown): JoinRules | undefined {
  if (value === undefined) {
    return NO_RULES;
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value["fields"]) ||
    !value["fields"].every(isField) ||
    typeof value["guestListOnly"] !== "boolean" ||
    !Array.isArray(value["emailDomains"]) ||
    !value["emailDomains"].every((domain) => typeof domain === "string") ||
    !(value["welcomePoints"] === null || typeof value["welcomePoints"] === "number")
  ) {
    return undefined;
  }
  return {
    fields: value["fields"].map((field) => ({
      id: field.id,
      kind: field.kind,
      label: field.label,
      required: field.required,
      options: Array.isArray(field.options)
        ? field.options.map((option: Partial<JoinOption> & { id: string }) => ({
            id: option.id,
            ar: option.ar ?? null,
            en: option.en ?? null,
          }))
        : null,
    })),
    guestListOnly: value["guestListOnly"],
    emailDomains: value["emailDomains"] as string[],
    welcomePoints: value["welcomePoints"],
  };
}

/** An event's own fields, checked; `withCode` for a card read by its code. */
function readEvent(event: unknown, withCode: boolean): CardEvent | InvitedEvent | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const strings = ["id", "startsAt", "endsAt", "timezone", ...(withCode ? ["joinCode"] : [])];
  const join = readRules(event["join"]);
  if (
    join === undefined ||
    strings.some((key) => typeof event[key] !== "string") ||
    !isRecord(event["name"]) ||
    !isRecord(event["venue"]) ||
    !["scheduled", "live", "ended"].includes(String(event["statusNow"])) ||
    !["public", "unlisted", "private"].includes(String(event["access"]))
  ) {
    return undefined;
  }
  return { ...(event as unknown as CardEvent), join };
}

/** Checks the card's shape, so a changed API shows "can't load" instead of a broken screen. */
export function readCard(
  body: unknown,
): Readonly<{ event: CardEvent; card: JoinCard }> | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const event = readEvent(body["event"], true);
  const card = readJoinCard(body["card"]);
  return event === undefined || card === undefined
    ? undefined
    : { event: event as CardEvent, card };
}

function cardAnswer(answer: ApiResult): CardAnswer {
  if (answer.kind === "network") {
    return { kind: "network" };
  }
  if (answer.kind === "error") {
    return {
      kind: answer.status === 429 ? "throttled" : answer.status === 404 ? "not_found" : "network",
    };
  }
  const read = readCard(answer.body);
  return read === undefined ? { kind: "network" } : { kind: "card", ...read };
}

/** The join card by its code, before or after sign-in (FR-121, FR-111). */
export async function fetchCard(client: Client, code: string): Promise<CardAnswer> {
  return cardAnswer(
    await client.request({ method: "GET", path: `/v1/public/events/${encodeURIComponent(code)}` }),
  );
}

export type JoinOutcome =
  | Readonly<{
      kind: "joined";
      eventId: string;
      status: "active" | "pending";
      alreadyMember: boolean;
      /** The welcome points this join granted (FR-136): the coin animation plays once when above 0. */
      welcome: number;
      /** On a full event's waiting list (FR-1821): pending until the organizer lets them in. */
      waitlisted: boolean;
    }>
  /** The card changed (join answers, a new version): show the new one; a new Join tap is the consent. */
  | Readonly<{ kind: "stale"; card: JoinCard }>
  /** A required answer is missing or one is not valid: the field to point at, when the API names it. */
  | Readonly<{ kind: "invalid_answers"; field: string | null; problem: LocalizedText | null }>
  | Readonly<{ kind: "refused"; code: string; problem: LocalizedText | null }>
  | Readonly<{ kind: "signed_out" | "network" }>;

function joinOutcome(answer: AuthedResult): JoinOutcome {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "ok") {
    const body = isRecord(answer.body) ? answer.body : {};
    const status = body["status"] === "pending" ? "pending" : "active";
    const welcome =
      typeof body["welcome"] === "number" && body["welcome"] > 0 ? body["welcome"] : 0;
    return typeof body["eventId"] === "string"
      ? {
          kind: "joined",
          eventId: body["eventId"],
          status,
          alreadyMember: body["alreadyMember"] === true,
          welcome,
          waitlisted: status === "pending" && body["waitlisted"] === true,
        }
      : { kind: "network" };
  }
  if (answer.code === "invalid_join_answers") {
    const field = answer.details["field"];
    return {
      kind: "invalid_answers",
      field: typeof field === "string" ? field : null,
      problem: answer.message,
    };
  }
  const card =
    answer.code === "card_version_stale" ? readJoinCard(answer.details["card"]) : undefined;
  if (card !== undefined) {
    return { kind: "stale", card };
  }
  return { kind: "refused", code: answer.code, problem: answer.message };
}

/** The answers worth sending: none at all when the card asked nothing. */
const answersPart = (answers: Readonly<Record<string, string>> | undefined) =>
  answers === undefined || Object.keys(answers).length === 0 ? {} : { answers };

/**
 * Joins with the card the person saw (FR-121): by its code, saying how they came, with the card's answers; `waitlist`
 * joins a full event's waiting list (FR-1821). A join is idempotent by event and player, so a retry after a lost answer
 * is safe.
 */
export async function joinEvent(
  session: Pick<Session, "request">,
  join: PendingJoin,
  waitlist = false,
): Promise<JoinOutcome> {
  return joinOutcome(
    await session.request({
      method: "POST",
      path: "/v1/join",
      body: {
        joinCode: join.code,
        via: join.via,
        cardVersion: join.cardVersion,
        ...answersPart(join.answers),
        ...(waitlist ? { waitlist: true } : {}),
      },
    }),
  );
}

/** Joins an event the player is invited to, without a code (FR-133). */
export async function joinInvitation(
  session: Pick<Session, "request">,
  join: Readonly<{
    eventId: string;
    cardVersion: string;
    answers?: Readonly<Record<string, string>> | undefined;
  }>,
  waitlist = false,
): Promise<JoinOutcome> {
  return joinOutcome(
    await session.request({
      method: "POST",
      path: "/v1/join",
      body: {
        eventId: join.eventId,
        via: "invite",
        cardVersion: join.cardVersion,
        ...answersPart(join.answers),
        ...(waitlist ? { waitlist: true } : {}),
      },
    }),
  );
}

export type Invitation = Readonly<{ event: InvitedEvent; card: JoinCard }>;

export type InvitationsAnswer =
  | Readonly<{ kind: "list"; invitations: readonly Invitation[] }>
  | Readonly<{ kind: "signed_out" | "network" }>;

/** Reads the invitations; one of another shape fails the list, so a changed API says "can't load". */
export function readInvitations(body: unknown): Invitation[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["invitations"])) {
    return undefined;
  }
  const read = body["invitations"].map((item: unknown) => {
    if (!isRecord(item)) {
      return undefined;
    }
    const event = readEvent(item["event"], false);
    const card = readJoinCard(item["card"]);
    return event === undefined || card === undefined ? undefined : { event, card };
  });
  return read.every((item) => item !== undefined) ? (read as Invitation[]) : undefined;
}

/** The player's invitations (FR-133): events whose guest list holds their phone or email. */
export async function fetchInvitations(
  session: Pick<Session, "request">,
): Promise<InvitationsAnswer> {
  const answer = await session.request({ method: "GET", path: "/v1/me/invitations" });
  if (answer.kind === "signed_out") {
    return { kind: "signed_out" };
  }
  const invitations = answer.kind === "ok" ? readInvitations(answer.body) : undefined;
  return invitations === undefined ? { kind: "network" } : { kind: "list", invitations };
}
