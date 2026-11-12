// Staff sign-up and sign-in for the demo script, in two steps so a person can type the emailed code in between:
// `begin*` sends the code and keeps the challenge in the state file; `finish` takes the code and keeps the session.
// The state file (mode 0600, outside the repository) holds the owner password only when the script generated it (a
// DEMO_OWNER_PASSWORD from the environment and the admin's password are never written), the challenge and the session
// cookies; nothing here prints any of them.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Reads the state file, or an empty state; a file that is not a JSON object stops the run before anything changes. */
export function loadState(file) {
  if (!existsSync(file)) {
    return {};
  }
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    state = undefined;
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(
      `state file unreadable: ${file} is not a JSON object. Fix it, or delete it and sign in again.`,
    );
  }
  return state;
}

/** Writes the state file whole or not at all: a temporary file (mode 0600) beside it, then a rename over it. */
export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing was written, or it is already gone.
    }
    throw error;
  }
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
