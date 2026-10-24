import type { LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Position } from "#src/event/location.ts";
import { completionAnswer, type CompletionAnswer } from "#src/event/quests-api.ts";
import type { Bilingual } from "#src/i18n/text.ts";

type Requester = Pick<Session, "request">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual => {
  const text = isRecord(value) ? value : {};
  return {
    ar: typeof text["ar"] === "string" ? text["ar"] : null,
    en: typeof text["en"] === "string" ? text["en"] : null,
  };
};

/** A tap's answer: a completion as a scan's, with the quest the tag completed. */
export type TapAnswer = CompletionAnswer & Readonly<{ questId?: string }>;

/**
 * The answer to `POST /v1/taps`: the completion and its quest, or the refusal. A tag the server does not know or that
 * is not a Questify tag is said in the API's own words, as a wrong code is.
 */
export function tapAnswerOf(answer: AuthedResult): TapAnswer {
  if (
    answer.kind === "error" &&
    (answer.code === "unknown_tag" || answer.code === "invalid_proof")
  ) {
    return { kind: "wrong_code", problem: answer.message };
  }
  const parsed = completionAnswer(answer);
  if (parsed.kind !== "completed" || answer.kind !== "ok" || !isRecord(answer.body)) {
    return parsed;
  }
  const questId = answer.body["questId"];
  return typeof questId === "string" ? { ...parsed, questId } : parsed;
}

/** What a tap sends (FR-313): the tag's token and the sticker's id, or the iPhone saying it could not read one. */
export type TapProof = Readonly<{
  code: string;
  uid: string | null;
  platform: "ios" | "android";
  position: Position | null;
}>;

/** A player's tap; the key is the caller's (`keyFor`), so a retry after a lost answer never pays twice. */
export async function tapTag(session: Requester, proof: TapProof, key: string): Promise<TapAnswer> {
  const unread = proof.uid === null && proof.platform === "ios";
  return tapAnswerOf(
    await session.request({
      method: "POST",
      path: "/v1/taps",
      body: {
        code: proof.code,
        uid: proof.uid,
        platform: proof.platform,
        ...(unread ? { uidReason: "platform" } : {}),
        ...(proof.position === null ? {} : { position: proof.position }),
      },
      headers: { "idempotency-key": key },
    }),
  );
}

/** A refusal in the API's own words. */
export type NfcRefused = Readonly<{ kind: "refused"; code: string; message: LocalizedText | null }>;
type Failed = NfcRefused | Readonly<{ kind: "network" | "signed_out" }>;

const failedOf = (answer: AuthedResult): Failed =>
  answer.kind === "error"
    ? { kind: "refused", code: answer.code, message: answer.message }
    : { kind: answer.kind === "signed_out" ? "signed_out" : "network" };

/** A quest the operator may write a tag for, and the tags they wrote (`GET …/nfc-tags`). */
export type WritePage = Readonly<{
  quests: ReadonlyArray<Readonly<{ id: string; title: Bilingual; tags: number }>>;
  tags: ReadonlyArray<
    Readonly<{ id: string; quest: Bilingual; label: string; locked: boolean; writtenAt: string }>
  >;
}>;

const rows = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

export function writePageOf(body: unknown): WritePage {
  const page = isRecord(body) ? body : {};
  return {
    quests: rows(page["quests"])
      .filter((row) => typeof row["id"] === "string")
      .map((row) => ({
        id: String(row["id"]),
        title: textOf(row["title"]),
        tags: Number(row["tags"] ?? 0),
      })),
    tags: rows(page["tags"])
      .filter((row) => typeof row["id"] === "string" && row["status"] === "active")
      .map((row) => ({
        id: String(row["id"]),
        quest: textOf(row["quest"]),
        label: typeof row["label"] === "string" ? row["label"] : "",
        locked: row["locked"] === true,
        writtenAt: String(row["writtenAt"] ?? ""),
      })),
  };
}

/** The operator's write page. */
export async function fetchWritePage(
  session: Requester,
  eventId: string,
): Promise<Readonly<{ kind: "page"; page: WritePage }> | Failed> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/operator/events/${encodeURIComponent(eventId)}/nfc-tags`,
  });
  return answer.kind === "ok" ? { kind: "page", page: writePageOf(answer.body) } : failedOf(answer);
}

const questPath = (eventId: string, questId: string) =>
  `/v1/operator/events/${encodeURIComponent(eventId)}/quests/${encodeURIComponent(questId)}/nfc-tags`;

/** Step 1 of a write: the URL to write and the ticket confirm needs. */
export async function prepareWrite(
  session: Requester,
  eventId: string,
  questId: string,
): Promise<Readonly<{ kind: "prepared"; url: string; ticket: string }> | Failed> {
  const answer = await session.request({
    method: "POST",
    path: `${questPath(eventId, questId)}/prepare`,
  });
  if (answer.kind !== "ok") {
    return failedOf(answer);
  }
  const body = isRecord(answer.body) ? answer.body : {};
  return typeof body["url"] === "string" && typeof body["ticket"] === "string"
    ? { kind: "prepared", url: body["url"], ticket: body["ticket"] }
    : { kind: "network" };
}

/** What the confirm answered: the tag is registered, and the one this sticker held before, if any. */
export type Confirmed = Readonly<{
  kind: "confirmed";
  replaced: Readonly<{ label: string; quest: Bilingual }> | null;
}>;

export function confirmedOf(body: unknown): Confirmed {
  const replaced = isRecord(body) && isRecord(body["replaced"]) ? body["replaced"] : null;
  return {
    kind: "confirmed",
    replaced:
      replaced === null
        ? null
        : {
            label: typeof replaced["label"] === "string" ? replaced["label"] : "",
            quest: textOf(replaced["quest"]),
          },
  };
}

/** Step 3 of a write: registers the written tag with its sticker id. */
export async function confirmWrite(
  session: Requester,
  request: Readonly<{
    eventId: string;
    questId: string;
    url: string;
    ticket: string;
    uid: string;
    label: string;
    locked: boolean;
  }>,
  key: string,
): Promise<Confirmed | Failed> {
  const answer = await session.request({
    method: "POST",
    path: questPath(request.eventId, request.questId),
    body: {
      code: request.url.slice(request.url.lastIndexOf("/") + 1),
      ticket: request.ticket,
      uid: request.uid,
      label: request.label,
      locked: request.locked,
    },
    headers: { "idempotency-key": key },
  });
  return answer.kind === "ok" ? confirmedOf(answer.body) : failedOf(answer);
}
