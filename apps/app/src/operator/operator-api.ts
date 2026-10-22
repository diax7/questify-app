import type { LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";
import { deskInfoOf, lookupOf, type DeskInfo, type Lookup } from "#src/operator/desk.ts";
import { stationResult, type StationResult } from "#src/operator/station.ts";

type Requester = Pick<Session, "request">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A refusal in the API's own words, for the screens to show as they are. */
export type Refused = Readonly<{ kind: "refused"; code: string; message: LocalizedText | null }>;
type Common = Refused | Readonly<{ kind: "network" }> | Readonly<{ kind: "signed_out" }>;

function common(answer: AuthedResult): Common {
  if (answer.kind === "error") {
    return { kind: "refused", code: answer.code, message: answer.message };
  }
  return { kind: answer.kind === "signed_out" ? "signed_out" : "network" };
}

export type InvitePreview = Readonly<{
  event: Readonly<{ id: string; name: Bilingual }>;
  abilities: readonly string[];
}>;

/** FR-903: what the confirm screen shows; nothing is written. */
export async function previewInvite(
  session: Requester,
  token: string,
): Promise<Readonly<{ kind: "preview"; preview: InvitePreview }> | Common> {
  const answer = await session.request({
    method: "POST",
    path: "/v1/operator-invites/preview",
    body: { token },
  });
  if (answer.kind !== "ok") {
    return common(answer);
  }
  const body = answer.body;
  const event = isRecord(body) ? body["event"] : undefined;
  if (!isRecord(event) || typeof event["id"] !== "string" || !isText(event["name"])) {
    return { kind: "network" };
  }
  return {
    kind: "preview",
    preview: {
      event: { id: event["id"], name: event["name"] },
      abilities: strings(isRecord(body) ? body["abilities"] : undefined),
    },
  };
}

export async function claimInvite(
  session: Requester,
  token: string,
  idempotencyKey: string,
): Promise<Readonly<{ kind: "claimed"; eventId: string }> | Common> {
  const answer = await session.request({
    method: "POST",
    path: "/v1/operator-invites/claim",
    body: { token },
    headers: { "idempotency-key": idempotencyKey },
  });
  if (answer.kind !== "ok") {
    return common(answer);
  }
  const eventId = isRecord(answer.body) ? answer.body["eventId"] : undefined;
  return typeof eventId === "string" ? { kind: "claimed", eventId } : { kind: "network" };
}

/** An event the person staffs (`GET /v1/me/operator-events`). */
export type OperatorEvent = Readonly<{
  eventId: string;
  name: Bilingual;
  statusNow: string;
  /** The event's zone, for the desk's hours. */
  timezone: string;
  abilities: readonly string[];
  canPlay: boolean;
  enrollmentStatus: string | null;
}>;

export async function fetchOperatorEvents(
  session: Requester,
): Promise<Readonly<{ kind: "events"; events: readonly OperatorEvent[] }> | Common> {
  const answer = await session.request({ method: "GET", path: "/v1/me/operator-events" });
  if (answer.kind !== "ok") {
    return common(answer);
  }
  const rows =
    isRecord(answer.body) && Array.isArray(answer.body["events"]) ? answer.body["events"] : [];
  const events = rows.flatMap((row: unknown): OperatorEvent[] =>
    isRecord(row) && typeof row["eventId"] === "string" && isText(row["name"])
      ? [
          {
            eventId: row["eventId"],
            name: row["name"],
            statusNow: String(row["statusNow"]),
            timezone: typeof row["timezone"] === "string" ? row["timezone"] : "Asia/Riyadh",
            abilities: strings(row["abilities"]),
            canPlay: row["canPlay"] === true,
            enrollmentStatus:
              typeof row["enrollmentStatus"] === "string" ? row["enrollmentStatus"] : null,
          },
        ]
      : [],
  );
  return { kind: "events", events };
}

/** A station the operator may pick (FR-921) and their counts at it. */
export type Station = Readonly<{
  questId: string;
  title: Bilingual;
  points: number;
  doneToday: number;
  doneTotal: number;
}>;

export async function fetchStations(
  session: Requester,
  eventId: string,
): Promise<Readonly<{ kind: "stations"; stations: readonly Station[] }> | Common> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/operator/events/${encodeURIComponent(eventId)}/stations`,
  });
  if (answer.kind !== "ok") {
    return common(answer);
  }
  const rows =
    isRecord(answer.body) && Array.isArray(answer.body["stations"]) ? answer.body["stations"] : [];
  const stations = rows.flatMap((row: unknown): Station[] =>
    isRecord(row) && typeof row["questId"] === "string" && isText(row["title"])
      ? [
          {
            questId: row["questId"],
            title: row["title"],
            points: Number(row["points"]),
            doneToday: Number(row["doneToday"]),
            doneTotal: Number(row["doneTotal"]),
          },
        ]
      : [],
  );
  return { kind: "stations", stations };
}

/** FR-923, FR-924: one scan at the station; `removed` means the owner removed this operator (FR-905). */
export async function scanPlayer(
  session: Requester,
  request: Readonly<{ questId: string; code: string; idempotencyKey: string }>,
): Promise<
  Readonly<{ kind: "result"; result: StationResult }> | Readonly<{ kind: "removed" }> | Common
> {
  const answer = await session.request({
    method: "POST",
    path: "/v1/operator/scan",
    body: { questId: request.questId, code: request.code },
    headers: { "idempotency-key": request.idempotencyKey },
  });
  if (answer.kind === "error" && answer.code === "not_operator") {
    return { kind: "removed" };
  }
  if (answer.kind !== "ok") {
    return common(answer);
  }
  const result = stationResult(answer.body);
  return result === undefined ? { kind: "network" } : { kind: "result", result };
}

/** FR-907: an operator the owner allows to play joins as a player, with the join card in force. */
export async function playAsPlayer(
  session: Requester,
  eventId: string,
  cardVersion: string,
  idempotencyKey: string,
): Promise<Readonly<{ kind: "joined" }> | Common> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/events/${encodeURIComponent(eventId)}/operator/play`,
    body: { cardVersion },
    headers: { "idempotency-key": idempotencyKey },
  });
  return answer.kind === "ok" ? { kind: "joined" } : common(answer);
}

/** The player's fixed My QR (ADR-137). */
export async function fetchMyQr(
  session: Requester,
): Promise<Readonly<{ kind: "code"; token: string }> | Common> {
  const answer = await session.request({ method: "GET", path: "/v1/me/qr" });
  if (answer.kind !== "ok") {
    return common(answer);
  }
  const token = isRecord(answer.body) ? answer.body["token"] : undefined;
  return typeof token === "string" ? { kind: "code", token } : { kind: "network" };
}

export async function resetMyQr(
  session: Requester,
  idempotencyKey: string,
): Promise<Readonly<{ kind: "code"; token: string }> | Common> {
  const answer = await session.request({
    method: "POST",
    path: "/v1/me/qr/reset",
    headers: { "idempotency-key": idempotencyKey },
  });
  if (answer.kind !== "ok") {
    return common(answer);
  }
  const token = isRecord(answer.body) ? answer.body["token"] : undefined;
  return typeof token === "string" ? { kind: "code", token } : { kind: "network" };
}

type Removed = Readonly<{ kind: "removed" }>;

/** FR-905: a removed operator's desk call answers `removed`, and the screen leaves operator mode. */
const removedOr = (answer: AuthedResult): Removed | Common =>
  answer.kind === "error" && answer.code === "not_operator" ? { kind: "removed" } : common(answer);

/** The desk's header before any scan (FR-1716). */
export async function fetchDesk(
  session: Requester,
  eventId: string,
): Promise<Readonly<{ kind: "desk"; desk: DeskInfo }> | Removed | Common> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/operator/events/${encodeURIComponent(eventId)}/desk`,
  });
  if (answer.kind !== "ok") {
    return removedOr(answer);
  }
  const desk = deskInfoOf(isRecord(answer.body) ? answer.body["desk"] : undefined);
  return desk === undefined ? { kind: "network" } : { kind: "desk", desk };
}

/** FR-925: who the desk scanned and what waits for them; nothing is written (FR-926). */
export async function lookUpAtDesk(
  session: Requester,
  eventId: string,
  code: string,
): Promise<Readonly<{ kind: "lookup"; lookup: Lookup }> | Removed | Common> {
  const answer = await session.request({
    method: "POST",
    path: "/v1/operator/desk/lookup",
    body: { eventId, code },
  });
  if (answer.kind !== "ok") {
    return removedOr(answer);
  }
  const lookup = lookupOf(answer.body);
  return lookup === undefined ? { kind: "network" } : { kind: "lookup", lookup };
}

/** Handed over (collect first: final) or Hand over (desk offer: the player accepts) (FR-507, FR-509). */
export async function handOverAtDesk(
  session: Requester,
  redemptionId: string,
  idempotencyKey: string,
): Promise<
  | Readonly<{ kind: "handed_over" }>
  | Readonly<{ kind: "offered"; offerUntil: string | null }>
  | Removed
  | Common
> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/operator/redemptions/${encodeURIComponent(redemptionId)}/hand-over`,
    headers: { "idempotency-key": idempotencyKey },
  });
  if (answer.kind !== "ok") {
    return removedOr(answer);
  }
  const body = isRecord(answer.body) ? answer.body : {};
  if (body["status"] === "handed_over") {
    return { kind: "handed_over" };
  }
  return body["status"] === "offered"
    ? {
        kind: "offered",
        offerUntil: typeof body["offerUntil"] === "string" ? body["offerUntil"] : null,
      }
    : { kind: "network" };
}

/** The desk's poll while it waits for the player's accept. */
export async function pollOffer(
  session: Requester,
  redemptionId: string,
): Promise<
  | Readonly<{ kind: "poll"; status: string; offered: boolean; offerUntil: string | null }>
  | Removed
  | Common
> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/operator/redemptions/${encodeURIComponent(redemptionId)}`,
  });
  if (answer.kind !== "ok") {
    return removedOr(answer);
  }
  const body = isRecord(answer.body) ? answer.body : {};
  return {
    kind: "poll",
    status: String(body["status"]),
    offered: body["offered"] === true,
    offerUntil: typeof body["offerUntil"] === "string" ? body["offerUntil"] : null,
  };
}

/** The operator's Cancel (FR-513, FR-1603): the player's points and the unit come back. */
export async function cancelAtDesk(
  session: Requester,
  redemptionId: string,
  idempotencyKey: string,
): Promise<Readonly<{ kind: "cancelled" }> | Removed | Common> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/operator/redemptions/${encodeURIComponent(redemptionId)}/cancel`,
    headers: { "idempotency-key": idempotencyKey },
  });
  return answer.kind === "ok" ? { kind: "cancelled" } : removedOr(answer);
}
