import type { AuthedResult, Session } from "#src/api/session.ts";
import { completionAnswer, type CompletionAnswer } from "#src/event/quests-api.ts";
import type { Bilingual } from "#src/i18n/text.ts";

/** A passport as `GET /v1/quests/{id}/passport` gives it (T-304b): how many steps it needs and each step. */
export type PassportView = Readonly<{
  needed: number;
  steps: readonly Readonly<{ id: string; name: Bilingual; done: boolean }>[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

/** The passport's answer, or undefined when it is not well formed (a changed API shows "can't load"). */
export function passportViewOf(body: unknown): PassportView | undefined {
  if (!isRecord(body) || typeof body["needed"] !== "number" || !Array.isArray(body["steps"])) {
    return undefined;
  }
  const steps = body["steps"];
  const wellFormed = steps.every(
    (step) =>
      isRecord(step) &&
      typeof step["id"] === "string" &&
      isText(step["name"]) &&
      typeof step["done"] === "boolean",
  );
  return wellFormed ? { needed: body["needed"], steps: steps as PassportView["steps"] } : undefined;
}

export async function fetchPassport(
  session: Pick<Session, "request">,
  questId: string,
): Promise<PassportView | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/quests/${encodeURIComponent(questId)}/passport`,
  });
  return answer.kind === "ok" ? passportViewOf(answer.body) : undefined;
}

/**
 * A step stamped and the passport not finished yet: how far the player is. `fresh` is false when this step was
 * stamped before (nothing changed).
 */
export type Stamped = Readonly<{
  kind: "stamped";
  questId: string;
  done: number;
  needed: number;
  fresh: boolean;
}>;

/** A stamp's answer: the progress, the payment when it finished the passport (with its quest), or a refusal. */
export type StampAnswer =
  | Stamped
  | (Extract<CompletionAnswer, { kind: "completed" }> & Readonly<{ questId: string }>)
  | Exclude<CompletionAnswer, { kind: "completed" }>;

export function stampAnswer(answer: AuthedResult): StampAnswer {
  if (answer.kind !== "ok") {
    return completionAnswer(answer) as Exclude<CompletionAnswer, { kind: "completed" }>;
  }
  const body = isRecord(answer.body) ? answer.body : {};
  const questId = body["questId"];
  const done = body["done"];
  const needed = body["needed"];
  if (typeof questId !== "string" || typeof done !== "number" || typeof needed !== "number") {
    return { kind: "failed" };
  }
  if (body["completed"] === null) {
    return { kind: "stamped", questId, done, needed, fresh: body["stamped"] === true };
  }
  const paid = completionAnswer({ ...answer, body: body["completed"] });
  return paid.kind === "completed" ? { ...paid, questId } : { kind: "failed" };
}

/** Stamps a passport step with its printed code's token; the key is the caller's, from `keyFor`. */
export async function stampStep(
  session: Pick<Session, "request">,
  stepId: string,
  code: string,
  idempotencyKey: string,
): Promise<StampAnswer> {
  return stampAnswer(
    await session.request({
      method: "POST",
      path: `/v1/steps/${encodeURIComponent(stepId)}/stamp`,
      body: { code },
      headers: { "idempotency-key": idempotencyKey },
    }),
  );
}
