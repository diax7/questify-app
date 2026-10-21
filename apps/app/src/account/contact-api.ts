import { MESSAGES, type Language, type LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { ContactEvent } from "#src/account/contact-flow.ts";
import type { Channel } from "#src/auth/sign-in-flow.ts";

export type ContactDeps = Readonly<{
  session: Pick<Session, "request">;
  now: () => number;
  /** A new Idempotency-Key for each Confirm tap (API.md: a wrong code's answer replays for its key). */
  newKey: () => string;
}>;

const OFFLINE = MESSAGES["signIn.offline"];
const SIGNED_OUT = MESSAGES["signIn.sessionEnded"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Asks for a code to the new phone or email (`POST /v1/me/contact/code`); a resend is the same request again. */
export async function requestContactCode(
  deps: ContactDeps,
  input: Readonly<{ channel: Channel; value: string; lang: Language }>,
): Promise<ContactEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/me/contact/code",
    body: input,
  });
  if (
    answer.kind === "ok" &&
    isRecord(answer.body) &&
    typeof answer.body["challengeToken"] === "string"
  ) {
    return {
      type: "code_sent",
      contact: input.value,
      challengeToken: answer.body["challengeToken"],
      now: deps.now(),
    };
  }
  return { type: "refused", problem: problemOf(answer) };
}

/** Checks the code (`POST /v1/me/contact/verify`); only a right code puts the new value on the account. */
export async function verifyContactCode(
  deps: ContactDeps,
  input: Readonly<{ challengeToken: string; code: string; lang: Language }>,
): Promise<ContactEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/me/contact/verify",
    headers: { "idempotency-key": deps.newKey() },
    body: input,
  });
  if (answer.kind === "ok") {
    return { type: "changed" };
  }
  if (answer.kind === "error" && answer.code === "invalid_code") {
    const left = answer.details["attemptsLeft"];
    return {
      type: "wrong_code",
      attemptsLeft: typeof left === "number" && Number.isFinite(left) ? left : 0,
      problem: answer.message,
    };
  }
  if (answer.kind === "error" && (answer.status === 410 || answer.code === "contact_in_use")) {
    return { type: "start_again", problem: answer.message };
  }
  return { type: "refused", problem: problemOf(answer) };
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
