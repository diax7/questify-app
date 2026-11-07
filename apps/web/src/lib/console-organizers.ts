import type { MessageKey } from "@questify/shared";
import { readSuspension, type Suspension } from "#src/lib/staff-api.ts";

/** The console's organizers (T-701): its list, one organizer, and an event's suspension and support grants. */
export const ORGANIZERS_API = "/v1/admin/organizers";

const HISTORY_KEYS: Readonly<Record<string, MessageKey>> = {
  "event.suspend": "console.history.eventSuspend",
  "event.reactivate": "console.history.eventReactivate",
  "organizer.suspend": "console.history.organizerSuspend",
  "organizer.reactivate": "console.history.organizerReactivate",
  "support.opened": "console.history.supportOpened",
  "support.closed": "console.history.supportClosed",
  "event.create": "console.history.eventCreate",
  "event.duplicate": "console.history.eventDuplicate",
  "event.delete": "console.history.eventDelete",
  "event.template": "console.history.eventTemplate",
  "event.activation.request": "console.history.activationRequest",
  "event.activation.withdraw": "console.history.activationWithdraw",
  "event.activation.reject": "console.history.activationReject",
  "event.activate": "console.history.eventActivate",
  "event.limit": "console.history.eventLimit",
  "event.end": "console.history.eventEnd",
  "event.lifecycle": "console.history.eventLifecycle",
  "event.results_confirmed": "console.history.resultsConfirmed",
  "event.results_revealed": "console.history.resultsRevealed",
  "event.export": "console.history.eventExport",
  "event.player_ban": "console.history.playerBan",
  "event.player_unban": "console.history.playerUnban",
  "content.unpublish": "console.history.contentUnpublish",
  "content.republish": "console.history.contentRepublish",
  "organizer.create": "console.history.organizerCreate",
  "organizer.owner.transfer": "console.history.ownerTransfer",
  "organizer.member.join": "console.history.memberJoin",
  "organizer.member.remove": "console.history.memberRemove",
  "organizer.member.scope": "console.history.memberScope",
  "event.update": "console.history.eventEdit",
  "event.names.update": "console.history.eventEdit",
  "event.texts.update": "console.history.eventEdit",
  "event.branding.update": "console.history.eventEdit",
  "event.layout.update": "console.history.eventEdit",
  "event.terms.update": "console.history.eventEdit",
  "event.focus_set": "console.history.eventEdit",
  "event.join_fields.update": "console.history.eventJoin",
  "event.join_rules.update": "console.history.eventJoin",
  "event.features.update": "console.history.eventFeatures",
  "event.shop.update": "console.history.eventShop",
  "event.guests.add": "console.history.guestsChange",
  "event.guests.remove": "console.history.guestsChange",
  "category.create": "console.history.categoryChange",
  "category.update": "console.history.categoryChange",
  "category.delete": "console.history.categoryChange",
  "category.reorder": "console.history.categoryChange",
  "quest.create": "console.history.questCreate",
  "quest.update": "console.history.questEdit",
  "quest.reorder": "console.history.questEdit",
  "quest_item.create": "console.history.questEdit",
  "quest_item.update": "console.history.questEdit",
  "quest_item.remove": "console.history.questEdit",
  "quest.delete": "console.history.questDelete",
  "quest.qr_regenerate": "console.history.questQr",
  "quest.step_qr_regenerate": "console.history.questQr",
  "reward.create": "console.history.rewardChange",
  "reward.update": "console.history.rewardChange",
  "reward.remove": "console.history.rewardChange",
  "reward.codes.add": "console.history.rewardChange",
  "rank_prize.create": "console.history.rewardChange",
  "rank_prize.update": "console.history.rewardChange",
  "rank_prize.remove": "console.history.rewardChange",
  "feature_request.allow": "console.history.featureRequestAllow",
  "feature_request.decline": "console.history.featureRequestDecline",
  "organizer.member.invite_cancel": "console.history.inviteCancel",
};
/** The words for an audit action in the console's history, or undefined for one without words (its name is shown). */
export function historyKeyOf(action: string): MessageKey | undefined {
  if (Object.hasOwn(HISTORY_KEYS, action)) {
    return HISTORY_KEYS[action];
  }
  return /^console\.[a-z_]+_read$/.test(action) ? "console.history.read" : undefined;
}

type Text = Readonly<{ ar: string | null; en: string | null }>;

export type OrganizerRow = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerEmail: string | null;
  events: Readonly<{ draft: number; scheduled: number; live: number }>;
}>;

export type HistoryEntry = Readonly<{
  id: string;
  at: string;
  actorType: string;
  action: string;
  bySupport: boolean;
  /** What a person typed for a suspension or its lifting (the entry's reason), else null. */
  reason: string | null;
}>;

export type OrganizerDetail = Readonly<{
  organizer: Readonly<{
    id: string;
    name: string;
    slug: string;
    status: string;
    suspension: Suspension | null;
  }>;
  team: readonly Readonly<{
    staffUserId: string;
    email: string;
    role: "owner" | "editor";
    limited: number | null;
  }>[];
  events: readonly Readonly<{
    id: string;
    joinCode: string;
    name: Text;
    statusNow: string;
    suspension: Suspension | null;
  }>[];
  history: readonly HistoryEntry[];
  ownerEmailChange: OwnerEmailChange | null;
  ownerOtherOrganizers: readonly string[];
}>;

/** The owner's open email change, else the latest one (T-701b). */
export type OwnerEmailChange = Readonly<{
  id: string;
  state: string;
  newEmail: string | null;
  expiresAt: string;
  appliesAt: string | null;
  closedAt: string | null;
  disputedAt: string | null;
}>;

function readOwnerEmailChange(value: unknown): OwnerEmailChange | null {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["state"] !== "string") {
    return null;
  }
  return {
    id: value["id"],
    state: value["state"],
    newEmail: text(value["newEmail"]),
    expiresAt: text(value["expiresAt"]) ?? "",
    appliesAt: text(value["appliesAt"]),
    closedAt: text(value["closedAt"]),
    disputedAt: text(value["disputedAt"]),
  };
}

export type SupportGrant = Readonly<{
  id: string;
  adminEmail: string;
  mine: boolean;
  expiresAt: string;
  /** `view` is read-only (T-712), `edit` can change (T-701). */
  kind: "view" | "edit";
}>;

/** What the console's event page adds for T-701: both suspensions and the live support grants. */
export type EventOversight = Readonly<{
  organizerId: string;
  suspension: Suspension | null;
  organizerSuspension: Suspension | null;
  grants: readonly SupportGrant[];
  history: readonly HistoryEntry[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const count = (value: unknown): number => (typeof value === "number" ? value : 0);
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** The list page's address for a search, a status and a cursor; empty parts are left out. */
export function organizersPath(
  query: Readonly<{ q: string; status: string; cursor?: string | null }>,
): string {
  const params = new URLSearchParams();
  if (query.q.trim() !== "") {
    params.set("q", query.q.trim());
  }
  if (query.status !== "") {
    params.set("status", query.status);
  }
  if (query.cursor !== undefined && query.cursor !== null) {
    params.set("cursor", query.cursor);
  }
  const search = params.toString();
  return search === "" ? ORGANIZERS_API : `${ORGANIZERS_API}?${search}`;
}

export function readOrganizerPage(
  value: unknown,
): Readonly<{ organizers: OrganizerRow[]; nextCursor: string | null }> | undefined {
  if (!isRecord(value) || !Array.isArray(value["organizers"])) {
    return undefined;
  }
  const organizers = records(value["organizers"]).flatMap((row): OrganizerRow[] => {
    const events = isRecord(row["events"]) ? row["events"] : {};
    return typeof row["id"] === "string" && typeof row["name"] === "string"
      ? [
          {
            id: row["id"],
            name: row["name"],
            slug: text(row["slug"]) ?? "",
            status: text(row["status"]) ?? "active",
            ownerEmail: text(row["ownerEmail"]),
            events: {
              draft: count(events["draft"]),
              scheduled: count(events["scheduled"]),
              live: count(events["live"]),
            },
          },
        ]
      : [];
  });
  return { organizers, nextCursor: text(value["nextCursor"]) };
}

function readHistory(value: unknown): HistoryEntry[] {
  return records(value).flatMap((entry) =>
    typeof entry["id"] === "string" && typeof entry["at"] === "string"
      ? [
          {
            id: entry["id"],
            at: entry["at"],
            actorType: text(entry["actorType"]) ?? "",
            action: text(entry["action"]) ?? "",
            bySupport: entry["bySupport"] === true,
            reason: text(entry["reason"]),
          },
        ]
      : [],
  );
}

export function readOrganizerDetail(value: unknown): OrganizerDetail | undefined {
  if (!isRecord(value) || !isRecord(value["organizer"])) {
    return undefined;
  }
  const organizer = value["organizer"];
  if (typeof organizer["id"] !== "string" || typeof organizer["name"] !== "string") {
    return undefined;
  }
  return {
    organizer: {
      id: organizer["id"],
      name: organizer["name"],
      slug: text(organizer["slug"]) ?? "",
      status: text(organizer["status"]) ?? "active",
      suspension: readSuspension(organizer["suspension"]),
    },
    team: records(value["team"]).map((member) => ({
      staffUserId: text(member["staffUserId"]) ?? "",
      email: text(member["email"]) ?? "",
      role: member["role"] === "owner" ? "owner" : "editor",
      limited: Array.isArray(member["eventScope"]) ? member["eventScope"].length : null,
    })),
    events: records(value["events"]).flatMap((event) =>
      typeof event["id"] === "string"
        ? [
            {
              id: event["id"],
              joinCode: text(event["joinCode"]) ?? "",
              name: isRecord(event["name"])
                ? { ar: text(event["name"]["ar"]), en: text(event["name"]["en"]) }
                : { ar: null, en: null },
              statusNow: text(event["statusNow"]) ?? "draft",
              suspension: readSuspension(event["suspension"]),
            },
          ]
        : [],
    ),
    history: readHistory(value["history"]),
    ownerEmailChange: readOwnerEmailChange(value["ownerEmailChange"]),
    ownerOtherOrganizers: Array.isArray(value["ownerOtherOrganizers"])
      ? value["ownerOtherOrganizers"].filter((name): name is string => typeof name === "string")
      : [],
  };
}

/** The T-701 part of the console event answer (`{ event: view }`), read beside T-210's own reader. */
export function readEventOversight(view: unknown): EventOversight | undefined {
  if (!isRecord(view) || !isRecord(view["event"])) {
    return undefined;
  }
  const event = view["event"];
  const organizer = isRecord(event["organizer"]) ? event["organizer"] : {};
  if (typeof organizer["id"] !== "string") {
    return undefined;
  }
  return {
    organizerId: organizer["id"],
    suspension: readSuspension(event["suspension"]),
    organizerSuspension: readSuspension(event["organizerSuspension"]),
    grants: records(view["supportGrants"]).flatMap((grant) =>
      typeof grant["id"] === "string" && typeof grant["expiresAt"] === "string"
        ? [
            {
              id: grant["id"],
              adminEmail: text(grant["adminEmail"]) ?? "",
              mine: grant["mine"] === true,
              expiresAt: grant["expiresAt"],
              kind: grant["kind"] === "edit" ? ("edit" as const) : ("view" as const),
            },
          ]
        : [],
    ),
    history: readHistory(view["history"]),
  };
}

/** A clock time in the viewer's language, Western digits always (ADR-018). */
export function clockOf(iso: string, language: "ar" | "en"): string {
  return new Intl.DateTimeFormat(language === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
