import type { AuthedResult, Session } from "#src/api/session.ts";
import { completionAnswer, type CompletionAnswer } from "#src/event/quests-api.ts";
import type { Bilingual } from "#src/i18n/text.ts";

/** A hidden category found (T-304c): its name; `fresh` is false when this player had found it before. */
export type Revealed = Readonly<{ kind: "revealed"; name: Bilingual; fresh: boolean }>;

export type RevealAnswer = Revealed | Exclude<CompletionAnswer, { kind: "completed" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

/**
 * The reveal route's answer: the category found, or a refusal as a scan's. A category that is not hidden is told in
 * the API's own words, as a wrong code.
 */
export function revealAnswer(answer: AuthedResult): RevealAnswer {
  if (answer.kind === "error" && answer.code === "not_hidden") {
    return { kind: "wrong_code", problem: answer.message };
  }
  if (answer.kind !== "ok") {
    return completionAnswer(answer) as Exclude<CompletionAnswer, { kind: "completed" }>;
  }
  const body = isRecord(answer.body) ? answer.body : {};
  return isText(body["name"]) && typeof body["revealed"] === "boolean"
    ? { kind: "revealed", name: body["name"], fresh: body["revealed"] }
    : { kind: "failed" };
}

/** Finds a hidden category with its secret code's token. It pays nothing, so it takes no Idempotency-Key. */
export async function revealCategory(
  session: Pick<Session, "request">,
  categoryId: string,
  code: string,
): Promise<RevealAnswer> {
  return revealAnswer(
    await session.request({
      method: "POST",
      path: `/v1/categories/${encodeURIComponent(categoryId)}/reveal`,
      body: { code },
    }),
  );
}
