import { MESSAGES, type Language, type LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { DeletionEvent, PendingPrize } from "#src/account/deletion-flow.ts";
import type { Channel } from "#src/auth/sign-in-flow.ts";

export type DeletionDeps = Readonly<{ session: Pick<Session, "request"> }>;

const OFFLINE = MESSAGES["signIn.offline"];
const SIGNED_OUT = MESSAGES["signIn.sessionEnded"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const bilingual = (value: unknown): PendingPrize["event"] => {
  const record = isRecord(value) ? value : {};
  const text = (key: string) => (typeof record[key] === "string" ? record[key] : null);
  return { ar: text("ar"), en: text("en") };
};

/** The waiting prizes an answer lists; anything malformed is left out rather than shown wrong. */
export function pendingOf(value: unknown): PendingPrize[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) =>
    typeof item["redemptionId"] === "string"
      ? [
          {
            redemptionId: item["redemptionId"],
            event: bilingual(item["event"]),
            item: bilingual(item["item"]),
            rankPrize: item["rankPrize"] === true,
          },
        ]
      : [],
  );
}

/** What a refused answer says: the API's own words, or why there were none. */
function problemOf(answer: AuthedResult): LocalizedText | null {
  if (answer.kind === "network") {
    return OFFLINE;
  }
  if (answer.kind === "signed_out") {
    return SIGNED_OUT;
  }
  return answer.kind === "error" ? answer.message : null;
}

/** Asks for a deletion code to the account's own phone, or its email (`POST /v1/me/deletion/code`). */
export async function requestDeletionCode(
  deps: DeletionDeps,
  input: Readonly<{ channel: Channel; lang: Language }>,
): Promise<DeletionEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/me/deletion/code",
    body: input,
  });
  if (
    answer.kind === "ok" &&
    isRecord(answer.body) &&
    typeof answer.body["challengeToken"] === "string"
  ) {
    return { type: "code_sent", challengeToken: answer.body["challengeToken"] };
  }
  return { type: "refused", problem: problemOf(answer) };
}

/** Checks the code (`POST /v1/deletion/verify`): a right one gives the deletion token and the waiting prizes. */
export async function verifyDeletionCode(
  deps: DeletionDeps,
  input: Readonly<{ challengeToken: string; code: string }>,
): Promise<DeletionEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/deletion/verify",
    body: input,
  });
  if (
    answer.kind === "ok" &&
    isRecord(answer.body) &&
    typeof answer.body["deletionToken"] === "string"
  ) {
    return {
      type: "verified",
      deletionToken: answer.body["deletionToken"],
      pending: pendingOf(answer.body["pending"]),
    };
  }
  if (answer.kind === "error" && answer.code === "invalid_code") {
    const left = answer.details["attemptsLeft"];
    return {
      type: "wrong_code",
      attemptsLeft: typeof left === "number" && Number.isFinite(left) ? left : 0,
      problem: answer.message,
    };
  }
  if (answer.kind === "error" && answer.status === 410) {
    return { type: "start_again", problem: answer.message };
  }
  return { type: "refused", problem: problemOf(answer) };
}

/** Deletes the account (`POST /v1/deletion/confirm`); a repeat after a lost answer is a 204 too. */
export async function confirmDeletion(
  deps: DeletionDeps,
  input: Readonly<{ deletionToken: string; forfeit: boolean }>,
): Promise<DeletionEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/deletion/confirm",
    body: input,
  });
  if (answer.kind === "ok") {
    return { type: "erased" };
  }
  if (answer.kind === "error" && answer.code === "handover_pending") {
    return {
      type: "pending",
      pending: pendingOf(answer.details["pending"]),
      problem: answer.message,
    };
  }
  if (answer.kind === "error" && answer.status === 410) {
    return { type: "start_again", problem: answer.message };
  }
  return { type: "refused", problem: problemOf(answer) };
}
