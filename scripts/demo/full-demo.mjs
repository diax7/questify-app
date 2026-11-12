#!/usr/bin/env node
// The full phone demo on staging (docs/demo/PHONE_DEMO.md): builds one live event with every quest kind, rewards with
// reward codes, rank prizes, a community goal, a map, sponsors, Home blocks and the agenda, through the real API routes,
// and writes the printable sheet of its codes. Fake data only; it refuses an API that is not staging or local.
//
//   node scripts/demo/full-demo.mjs signup            first time: makes the owner account, emails its code
//   node scripts/demo/full-demo.mjs login [--as admin] signs in again (owner by default), emails the code
//   node scripts/demo/full-demo.mjs code <123456> [--as admin]   takes the emailed code; keeps the session
//   node scripts/demo/full-demo.mjs build [--reset]   builds or completes the demo (admin part when signed in as admin)
//                                                     and writes the QR sheet; run again any time, it adds only what
//                                                     is missing; --reset ends the demo event and builds a new one
//   node scripts/demo/full-demo.mjs logout            ends both sessions and forgets them
//
// Settings (environment): DEMO_OWNER_EMAIL (signup, login), DEMO_OWNER_PASSWORD (optional: else a long random one is
// made and kept in the state file; the owner sets their own with "Forgot password?"), DEMO_ADMIN_EMAIL and
// DEMO_ADMIN_PASSWORD (only for `login --as admin`), DEMO_API (default the staging API), DEMO_WEB (default
// https://questify.nafes.com), DEMO_OUT (where the QR sheet goes, default ~/.questify-demo), DEMO_STATE (default
// ~/.questify-demo/<api host>.json, mode 0600), DEMO_CODE (instead of the code argument). Nothing secret is
// printed: not the password, the code, the challenge or the session.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  acceptance,
  beginSignIn,
  beginSignUp,
  finish,
  generatedPassword,
  loadState,
  saveState,
  signOut,
  whoAmI,
} from "./lib/auth.mjs";
import { ORGANIZER_NAME } from "./lib/content.mjs";
import { createApi } from "./lib/http.mjs";
import { qrSheet } from "./lib/print.mjs";
import { buildDemo } from "./lib/run.mjs";

/** One line on standard output (never a secret: see the header). */
const say = (line) => process.stdout.write(`${line}\n`);

const API = process.env.DEMO_API ?? "https://questify-api-staging-3ez01s.cranl.net";
const WEB = process.env.DEMO_WEB ?? "https://questify.nafes.com";
const HOST = new URL(API).host;
const DIR = process.env.DEMO_OUT ?? join(homedir(), ".questify-demo");
const STATE = process.env.DEMO_STATE ?? join(DIR, `${HOST.replace(/[^a-z0-9.-]/gi, "_")}.json`);

/** Staging or this machine only (fake data, ADR-810): production holds real people. */
function checkTarget() {
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(HOST);
  const staging = /^questify-api-staging-[a-z0-9]+\.cranl\.net$/.test(HOST);
  if (!local && !(staging && new URL(API).protocol === "https:")) {
    throw new Error(
      `Refusing ${HOST}: the demo runs against the https staging API or a local API only.`,
    );
  }
}

function need(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

const roleOf = (args) =>
  args.includes("--as") && args[args.indexOf("--as") + 1] === "admin" ? "admin" : "owner";

function ownerPassword(state) {
  state.owner ??= {};
  state.owner.password ??= process.env.DEMO_OWNER_PASSWORD || generatedPassword();
  return state.owner.password;
}

function credentials(state, role) {
  return role === "admin"
    ? { email: need("DEMO_ADMIN_EMAIL"), password: need("DEMO_ADMIN_PASSWORD") }
    : { email: need("DEMO_OWNER_EMAIL"), password: ownerPassword(state) };
}

async function begin(api, state, role, signUp) {
  const who = credentials(state, role);
  const pending = signUp
    ? await beginSignUp(api, { ...who, organizerName: ORGANIZER_NAME })
    : await beginSignIn(api, who);
  state[role] = { ...state[role], pending };
  saveState(STATE, state);
  say(
    `A code was emailed to the ${role} account's mailbox. Run: node scripts/demo/full-demo.mjs code <code>${role === "admin" ? " --as admin" : ""}`,
  );
}

async function takeCode(api, state, role, code) {
  const pending = state[role]?.pending;
  if (pending === undefined) {
    throw new Error(`No ${role} sign-in is waiting for a code: run signup or login first.`);
  }
  if (!/^[0-9]{6}$/.test(code ?? "")) {
    throw new Error("The code is six digits.");
  }
  const { cookie } = await finish(api, pending, code);
  state[role] = { ...state[role], pending: undefined, cookie };
  saveState(STATE, state);
  say(`Signed in as the ${role}.`);
}

/** A live session of this role, or undefined (a dead one is forgotten). */
async function session(api, state, role) {
  const cookie = state[role]?.cookie;
  if (cookie === undefined) {
    return undefined;
  }
  if ((await whoAmI(api, cookie)) === undefined) {
    state[role] = { ...state[role], cookie: undefined };
    saveState(STATE, state);
    return undefined;
  }
  return cookie;
}

function writeSheet(demo) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = join(DIR, "demo-codes.html");
  writeFileSync(file, qrSheet(demo, { web: WEB }));
  const summary = {
    joinCode: demo.joinCode,
    eventId: demo.eventId,
    organizerId: demo.organizerId,
    entryCodes: demo.entryCodes,
  };
  writeFileSync(join(DIR, "demo-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return file;
}

async function build(api, state, reset) {
  const ownerCookie = await session(api, state, "owner");
  if (ownerCookie === undefined) {
    throw new Error("The owner is not signed in: run login, then code.");
  }
  const adminCookie = await session(api, state, "admin");
  const demo = await buildDemo({
    api,
    ownerCookie,
    adminCookie,
    accept: await acceptance(api, "organizer"),
    reset,
  });
  for (const line of demo.log) {
    say(`- ${line}`);
  }
  state.lastDemo = { eventId: demo.eventId, organizerId: demo.organizerId };
  saveState(STATE, state);
  const sheet = writeSheet(demo);
  say(`\nJoin code: ${demo.joinCode}`);
  say(`Dashboard: ${WEB}/en/organizers/${demo.organizerId}/events/${demo.eventId}`);
  say(`Play in a phone browser: ${WEB}/play`);
  say(`QR sheet: ${sheet}`);
}

async function logout(api, state) {
  for (const role of ["owner", "admin"]) {
    if (state[role]?.cookie !== undefined) {
      await signOut(api, state[role].cookie);
      state[role] = { ...state[role], cookie: undefined };
    }
  }
  saveState(STATE, state);
  say("Signed out.");
}

async function main([command, ...args]) {
  checkTarget();
  const api = createApi({ api: API, origin: WEB });
  const state = loadState(STATE);
  const role = roleOf(args);
  const commands = {
    signup: () => begin(api, state, "owner", true),
    login: () => begin(api, state, role, false),
    code: () =>
      takeCode(api, state, role, process.env.DEMO_CODE ?? args.find((a) => /^[0-9]{6}$/.test(a))),
    build: () => build(api, state, args.includes("--reset")),
    logout: () => logout(api, state),
  };
  const run = commands[command];
  if (run === undefined) {
    throw new Error(
      "Usage: full-demo.mjs signup | login [--as admin] | code <code> [--as admin] | build [--reset] | logout",
    );
  }
  await run();
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
