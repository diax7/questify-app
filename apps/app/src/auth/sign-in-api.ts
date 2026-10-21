import { MESSAGES, toWesternDigits, type Language, type SignupAcceptance } from "@questify/shared";
import type { ApiResult, Client } from "#src/api/client.ts";
import type { Issued, Session } from "#src/api/session.ts";
import type { Channel, SignInEvent } from "#src/auth/sign-in-flow.ts";
import { versionsFrom } from "#src/config/remote.ts";

export type SignInDeps = Readonly<{
  client: Client;
  session: Pick<Session, "start">;
  now: () => number;
}>;

const OFFLINE = MESSAGES["signIn.offline"];

/**
 * What a person typed into a number field, in Western digits and trimmed: an Arabic phone keypad types ١٩٩٥, which
 * `Number` cannot read (it would reach the API as null). Used for the code and the birth year.
 */
export const westernDigits = (typed: string): string => toWesternDigits(typed).trim();

/** A phone number or an email kept left to right inside Arabic text (U+2066 … U+2069 isolate it). */
export const isolatedLtr = (text: string): string => `⁦${text}⁩`;

const problemOf = (answer: ApiResult) =>
  answer.kind === "network" ? OFFLINE : answer.kind === "error" ? answer.message : null;

const numberOf = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isIssued = (value: unknown): value is Issued =>
  isRecord(value) &&
  typeof value["accessToken"] === "string" &&
  typeof value["refreshToken"] === "string" &&
  typeof value["expiresInSeconds"] === "number";

/** Asks for a code (FR-106); the versions the person just accepted travel with it (FR-1705). */
export async function requestCode(
  deps: SignInDeps,
  input: Readonly<{
    channel: Channel;
    value: string;
    lang: Language;
    versions: SignupAcceptance;
    previous?: string;
  }>,
): Promise<SignInEvent> {
  const answer = await deps.client.request({
    method: "POST",
    path: "/v1/auth/code",
    body: {
      channel: input.channel,
      value: input.value,
      lang: input.lang,
      accept: input.versions,
      ...(input.previous === undefined ? {} : { previous: input.previous }),
    },
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
      resendAfterSeconds: numberOf(answer.body["resendAfterSeconds"], 60),
      emailFallbackAfterSeconds:
        input.channel === "phone" ? numberOf(answer.body["emailFallbackAfterSeconds"], 30) : null,
    };
  }
  // The terms changed since the screen loaded them: show the new versions; retrying with the old ones never works.
  if (answer.kind === "error" && answer.code === "acceptance_required") {
    return {
      type: "versions_changed",
      versions: versionsFrom(answer.details["documents"]),
      problem: MESSAGES["signIn.versionsChanged"],
    };
  }
  return {
    type: "refused",
    problem: problemOf(answer),
    offerEmail: answer.kind === "error" && answer.details["emailOffered"] === true,
  };
}

/** Sends a new code for the same challenge, after its wait. */
export async function resendCode(
  deps: SignInDeps,
  input: Readonly<{ challengeToken: string; lang: Language }>,
): Promise<SignInEvent> {
  const answer = await deps.client.request({
    method: "POST",
    path: "/v1/auth/resend",
    body: input,
  });
  if (answer.kind === "ok" && isRecord(answer.body)) {
    return {
      type: "resent",
      now: deps.now(),
      resendAfterSeconds: numberOf(answer.body["resendAfterSeconds"], 60),
    };
  }
  return answer.kind === "error" && answer.status === 410
    ? { type: "expired", problem: answer.message }
    : { type: "refused", problem: problemOf(answer) };
}

/** Checks the code: a returning player is signed in; a new contact goes on to the profile step. */
export async function verifyCode(
  deps: SignInDeps,
  input: Readonly<{ challengeToken: string; code: string }>,
): Promise<SignInEvent> {
  const answer = await deps.client.request({
    method: "POST",
    path: "/v1/auth/verify",
    body: input,
  });
  if (answer.kind === "ok" && isIssued(answer.body)) {
    await deps.session.start(answer.body);
    return { type: "signed_in" };
  }
  if (
    answer.kind === "ok" &&
    isRecord(answer.body) &&
    typeof answer.body["signupToken"] === "string"
  ) {
    return { type: "new_player", signupToken: answer.body["signupToken"] };
  }
  if (answer.kind === "error" && answer.code === "invalid_code") {
    return {
      type: "wrong_code",
      attemptsLeft: numberOf(answer.details["attemptsLeft"], 0),
      problem: answer.message,
    };
  }
  if (answer.kind === "error" && answer.status === 410) {
    return { type: "expired", problem: answer.message };
  }
  return { type: "refused", problem: problemOf(answer) };
}

/** The profile step for a new player (T-109): username, birth year and avatar; success signs them in. */
export async function signUp(
  deps: SignInDeps,
  input: Readonly<{ signupToken: string; username: string; birthYear: number; avatar: string }>,
): Promise<SignInEvent> {
  const answer = await deps.client.request({
    method: "POST",
    path: "/v1/auth/signup",
    body: input,
  });
  if (answer.kind === "ok" && isIssued(answer.body)) {
    await deps.session.start(answer.body);
    return { type: "signed_in" };
  }
  return answer.kind === "error" && answer.code === "signup_expired"
    ? { type: "expired", problem: answer.message }
    : { type: "refused", problem: problemOf(answer) };
}
