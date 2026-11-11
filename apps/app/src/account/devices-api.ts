import { MESSAGES, type Language, type LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Device, DevicesEvent, Target } from "#src/account/devices-flow.ts";
import type { Channel } from "#src/auth/sign-in-flow.ts";

export type DevicesDeps = Readonly<{
  session: Pick<Session, "request">;
  now: () => number;
  /** A new Idempotency-Key for each tap (API.md: the first answer replays for its key). */
  newKey: () => string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPlatform = (value: unknown): boolean =>
  value === null || value === "ios" || value === "android" || value === "web";
const isModel = (value: unknown): boolean => value === null || typeof value === "string";
const hasTimes = (value: Record<string, unknown>): boolean =>
  typeof value["signedInAt"] === "string" && typeof value["lastUsedAt"] === "string";

const isDevice = (value: unknown): value is Device =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["current"] === "boolean" &&
  hasTimes(value) &&
  isPlatform(value["platform"]) &&
  isModel(value["model"]);

/** What a refused answer says: the API's own words, or why there were none. */
function problemOf(answer: AuthedResult): LocalizedText | null {
  if (answer.kind === "network") return MESSAGES["signIn.offline"];
  if (answer.kind === "signed_out") return MESSAGES["signIn.sessionEnded"];
  return answer.kind === "error" ? answer.message : null;
}

/** `GET /v1/me/devices`: this phone first, then by last use. */
export async function loadDevices(deps: DevicesDeps): Promise<DevicesEvent> {
  const answer = await deps.session.request({ method: "GET", path: "/v1/me/devices" });
  if (answer.kind === "ok" && isRecord(answer.body) && Array.isArray(answer.body["devices"])) {
    return { type: "loaded", devices: answer.body["devices"].filter(isDevice) };
  }
  return { type: "load_failed", problem: problemOf(answer) };
}

/** The other devices of the list, for the offer after a contact change. */
export async function otherDeviceCount(deps: DevicesDeps): Promise<number> {
  const loaded = await loadDevices(deps);
  return loaded.type === "loaded" ? loaded.devices.filter((d) => !d.current).length : 0;
}

/** Signs one other device, or all of them, out. 403 `reauth_required` asks for a code first. */
export async function endDevices(deps: DevicesDeps, target: Target): Promise<DevicesEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path:
      target.kind === "one"
        ? `/v1/me/devices/${encodeURIComponent(target.id)}/end`
        : "/v1/me/devices/end-others",
    headers: { "idempotency-key": deps.newKey() },
    body: {},
  });
  if (answer.kind === "ok") return { type: "ended", target };
  if (answer.kind === "error" && answer.code === "reauth_required")
    return { type: "reauth_required" };
  if (answer.kind === "error" && answer.status === 404) return { type: "gone" };
  return { type: "refused", problem: problemOf(answer) };
}

/** `POST /v1/me/reauth/code`: a code to the account's own phone or email; the answer names it masked. */
export async function requestReauthCode(
  deps: DevicesDeps,
  input: Readonly<{ channel: Channel; lang: Language }>,
): Promise<DevicesEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/me/reauth/code",
    body: input,
  });
  if (
    answer.kind === "ok" &&
    isRecord(answer.body) &&
    typeof answer.body["challengeToken"] === "string" &&
    typeof answer.body["sentTo"] === "string"
  ) {
    return {
      type: "code_sent",
      challengeToken: answer.body["challengeToken"],
      sentTo: answer.body["sentTo"],
      now: deps.now(),
    };
  }
  return { type: "refused", problem: problemOf(answer) };
}

/** `POST /v1/me/reauth/verify`: a right code makes this phone's sign-in fresh for 10 minutes. */
export async function verifyReauthCode(
  deps: DevicesDeps,
  input: Readonly<{ challengeToken: string; code: string }>,
): Promise<DevicesEvent> {
  const answer = await deps.session.request({
    method: "POST",
    path: "/v1/me/reauth/verify",
    headers: { "idempotency-key": deps.newKey() },
    body: input,
  });
  if (answer.kind === "ok") return { type: "confirmed" };
  if (answer.kind === "error" && answer.code === "invalid_code") {
    const left = answer.details["attemptsLeft"];
    return {
      type: "wrong_code",
      attemptsLeft: typeof left === "number" && Number.isFinite(left) ? left : 0,
      problem: answer.message,
    };
  }
  if (answer.kind === "error" && answer.status === 410) {
    return { type: "code_expired", problem: answer.message };
  }
  return { type: "refused", problem: problemOf(answer) };
}
