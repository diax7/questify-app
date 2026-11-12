// Staff sign-up and sign-in for the demo script, in two steps so a person can type the emailed code in between:
// `begin*` sends the code and keeps the challenge in the state file; `finish` takes the code and keeps the session.
// The state file (mode 0600, outside the repository) holds the generated password, the challenge and the session
// cookie; nothing here prints any of them.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Reads the state file, or an empty state. */
export function loadState(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** A long random password nobody types: the owner sets their own with "Forgot password?". */
export const generatedPassword = () => `demo-${randomBytes(24).toString("base64url")}`;

const FIELDS = {
  organizer: {
    terms: "organizer_terms",
    dpa: "organizer_dpa",
    contentRules: "organizer_content_rules",
  },
  player: { terms: "terms_of_use", privacy: "privacy_policy" },
};

/** The documents in force as a sign-up accepts them (`organizer`: the dashboard's form; `player`: the app's). */
export async function acceptance(api, kind) {
  const { body } = await api.call("GET", "/v1/legal");
  const versionOf = (id) => body.documents.find((doc) => doc.document === id)?.version;
  return Object.fromEntries(
    Object.entries(FIELDS[kind]).map(([field, id]) => [field, versionOf(id)]),
  );
}

/** Sends the sign-up code for a new account and its first organizer. */
export async function beginSignUp(api, { email, password, organizerName }) {
  const accept = await acceptance(api, "organizer");
  const { body } = await api.call("POST", "/v1/staff/auth/sign-up", {
    body: { email, password, organizerName, accept },
  });
  return { step: "sign-up", challengeToken: body.challengeToken };
}

/** Sends the sign-in code for an existing account. */
export async function beginSignIn(api, { email, password }) {
  const { body } = await api.call("POST", "/v1/staff/auth/password", {
    body: { email, password },
  });
  return { step: "sign-in", challengeToken: body.challengeToken };
}

/** Takes the emailed code: answers the session cookie (and, after a sign-up, the new organizer's id). */
export async function finish(api, pending, code) {
  const path = pending.step === "sign-up" ? "/v1/staff/auth/sign-up/code" : "/v1/staff/auth/code";
  const answer = await api.call("POST", path, {
    body: { challengeToken: pending.challengeToken, code },
  });
  if (answer.cookie === undefined) {
    throw new Error("The API answered without a session cookie.");
  }
  return { cookie: answer.cookie, organizerId: answer.body.organizerId };
}

/** The signed-in account, or undefined when the session has ended. */
export async function whoAmI(api, cookie) {
  const answer = await api.call("GET", "/v1/staff/me", {
    cookie,
    expect: [200, 401],
  });
  return answer.status === 200 ? answer.body : undefined;
}

export async function signOut(api, cookie) {
  await api.call("POST", "/v1/staff/auth/sign-out", {
    cookie,
    body: {},
    expect: [200, 204, 401],
  });
}
