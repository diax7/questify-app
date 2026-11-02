import type { ComposedConfig, LocalizedText, MessageKey } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import { loadConfig, type KeyValueStore } from "#src/config/remote.ts";
import { levelUpOf, type LevelUp } from "#src/questify/level.ts";

/** One of the player's own submissions, as `GET /v1/events/{id}/submissions/mine` gives it (T-301). */
export type OwnSubmission = Readonly<{
  id: string;
  questId: string;
  status: "pending" | "approved" | "rejected" | "removed";
  points: number;
  text: string | null;
  reason: string | null;
  /** The system closed it (the player left the event): `reason` is a code, not a person's words. */
  reasonSystem: boolean;
  /** The quest takes another submission after a rejection (FR-1709). */
  resubmit: boolean;
}>;

export type MySubmissions = Readonly<{
  submissions: readonly OwnSubmission[];
  pendingPoints: number;
}>;

const STATUSES = ["pending", "approved", "rejected", "removed"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nullableText = (value: unknown) => value === null || typeof value === "string";

const isOwn = (value: unknown): value is OwnSubmission =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["questId"] === "string" &&
  (STATUSES as readonly unknown[]).includes(value["status"]) &&
  typeof value["points"] === "number" &&
  nullableText(value["text"]) &&
  nullableText(value["reason"]) &&
  typeof value["reasonSystem"] === "boolean" &&
  typeof value["resubmit"] === "boolean";

/** Reads the player's list; anything malformed reads as nothing, so the sheet shows a load failure, not a guess. */
export function mySubmissionsOf(body: unknown): MySubmissions | undefined {
  if (!isRecord(body) || !Array.isArray(body["submissions"])) {
    return undefined;
  }
  const pending = body["pendingPoints"];
  if (typeof pending !== "number" || !body["submissions"].every(isOwn)) {
    return undefined;
  }
  return { submissions: body["submissions"] as OwnSubmission[], pendingPoints: pending };
}

/**
 * What the sheet offers for a submission quest now, from the player's latest submission for it: write (none yet, or
 * one approved on a repeatable quest the server still lists open), wait, write again after a rejection the quest
 * allows, or closed.
 */
export type SubmissionStep =
  | Readonly<{ kind: "write" }>
  | Readonly<{ kind: "pending"; points: number }>
  | Readonly<{ kind: "rejected"; reason: string | null; again: boolean; system: boolean }>
  | Readonly<{ kind: "removed"; reason: string | null }>;

export function submissionStep(
  questId: string,
  submissions: readonly OwnSubmission[],
): SubmissionStep {
  // The list is newest first: the first one for this quest is the latest.
  const latest = submissions.find((submission) => submission.questId === questId);
  switch (latest?.status) {
    case "pending":
      return { kind: "pending", points: latest.points };
    case "rejected":
      return {
        kind: "rejected",
        reason: latest.reasonSystem ? null : latest.reason,
        // A system rejection (the player left) never closes the quest.
        again: latest.resubmit || latest.reasonSystem,
        system: latest.reasonSystem,
      };
    case "removed":
      return { kind: "removed", reason: latest.reason };
    default:
      return { kind: "write" };
  }
}

/** The answer to a send, in the words the sheet needs. */
export type SendAnswer =
  | Readonly<{
      kind: "sent";
      status: "pending" | "approved";
      points: number;
      levelUp: LevelUp | null;
    }>
  /** The guidelines in force must be accepted first (FR-1706). */
  | Readonly<{ kind: "guidelines" }>
  | Readonly<{ kind: "refused"; message: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

export function sendAnswer(answer: AuthedResult): SendAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    return answer.code === "guidelines_required"
      ? { kind: "guidelines" }
      : { kind: "refused", message: answer.message };
  }
  const body = answer.body;
  if (
    !isRecord(body) ||
    (body["status"] !== "pending" && body["status"] !== "approved") ||
    typeof body["points"] !== "number"
  ) {
    return { kind: "network" };
  }
  return {
    kind: "sent",
    status: body["status"],
    points: body["points"],
    levelUp: levelUpOf(body["levelUp"]),
  };
}

/** The line a sent answer shows: pending points, or the points when the quest approves at once. */
export function sentLine(answer: Extract<SendAnswer, { kind: "sent" }>): MessageKey {
  return answer.status === "pending" ? "submission.sentPending" : "submission.sentApproved";
}

/** Bounds the box as the server does (1000 characters after trimming); the server cleans the rest. */
export const canSend = (text: string): boolean => {
  const length = text.trim().length;
  return length >= 1 && length <= 1000;
};

/**
 * Keeps one Idempotency-Key per piece of text: a retry after a dropped connection sends the same key, and changed text
 * gets a new one (the server refuses one key for two texts).
 */
export function sendKey(
  last: Readonly<{ key: string; text: string }> | undefined,
  text: string,
  fresh: () => string,
): string {
  return last !== undefined && last.text === text ? last.key : fresh();
}

export async function fetchMySubmissions(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<MySubmissions | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${encodeURIComponent(eventId)}/submissions/mine`,
  });
  return answer.kind === "ok" ? mySubmissionsOf(answer.body) : undefined;
}

export async function sendSubmission(
  session: Pick<Session, "request">,
  questId: string,
  text: string,
  key: string,
): Promise<SendAnswer> {
  return sendAnswer(
    await session.request({
      method: "POST",
      path: `/v1/quests/${encodeURIComponent(questId)}/submit`,
      body: { text },
      headers: { "idempotency-key": key },
    }),
  );
}

/** The guidelines version in force, from the configuration's legal block; empty when it is not there. */
export const guidelinesVersion = (config: ComposedConfig | undefined): string =>
  config?.legal.documents.find((document) => document.id === "community_guidelines")?.version ?? "";

/**
 * Records the player's acceptance of the guidelines before a first submission (FR-1706), at the version the configuration
 * names. The server checks it is the one in force and, when an admin published a newer one since, answers with the
 * versions in force, which are accepted in a second try.
 */
export async function acceptGuidelines(
  deps: Readonly<{ session: Pick<Session, "request">; store: KeyValueStore }>,
): Promise<boolean> {
  const { session } = deps;
  const version = guidelinesVersion(await loadConfig({ client: session, store: deps.store }));
  const send = (guidelines: string) =>
    session.request({ method: "POST", path: "/v1/me/acceptances", body: { guidelines } });
  const answer = await send(version);
  if (answer.kind === "error" && answer.code === "acceptance_required") {
    const current = guidelinesFrom(answer.details["documents"]);
    return current !== undefined && (await send(current)).kind === "ok";
  }
  return answer.kind === "ok";
}

/** The guidelines' version among the `{id, version}` documents a refusal lists. */
function guidelinesFrom(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const found = value.find(
    (item): item is { id: string; version: string } =>
      typeof item === "object" &&
      item !== null &&
      (item as { id?: unknown }).id === "community_guidelines" &&
      typeof (item as { version?: unknown }).version === "string",
  );
  return found?.version;
}
