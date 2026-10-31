// Decides which heavier CI steps a change needs, from the files it touches (CI budget rules: scope by changed files).
// Prints `web=true|false`, `e2e=true|false` and `specs=` lines for $GITHUB_OUTPUT; the reason goes to stderr (ADR-372).
// `specs=all` means the whole browser suite; otherwise a space-separated list of spec files, relative to apps/web.
// Usage: node scripts/ci-scope.mjs <base-ref-or-sha>
// When the base is missing or unknown (first push, force push), everything runs: never skip on doubt.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = [
  /^apps\/web\//,
  /^packages\/shared\//,
  /^pnpm-lock\.yaml$/,
  /^\.github\/workflows\//,
  /^scripts\/ci-scope\.mjs$/,
];
// The browser tests boot the whole API in-process, so any API source or migration change can break sign-in.
const E2E = [
  ...WEB,
  /^apps\/api\/src\//,
  /^apps\/api\/migrations\//,
  /^apps\/api\/test\/(e2e-server|support\/(auth-app|big-screen|test-db)\.ts$)/,
];
// A unit test cannot change what ships, so it never starts a build or a browser run.
const TEST_FILE = /\.test\.[cm]?tsx?$/;

/** Always run: the layout check reads every page, so it also proves the API and the web app boot. */
export const LAYOUT_SPECS = ["layout", "layout-check"];
/** More specs than this is a broad change: 20 specs and the layout check take about 9 minutes, the whole suite 16. */
export const MAX_AREA_SPECS = 20;

/** Code every page depends on: a change here runs the whole browser suite. */
const SHARED = [
  /^\.github\/workflows\//,
  /^pnpm-lock\.yaml$/,
  /^scripts\/ci-scope\.mjs$/,
  /^apps\/web\/(package\.json|playwright\.config\.ts|next\.config\.ts|tsconfig\.json)$/,
  /^apps\/web\/src\/(ui\/|proxy\.ts$|app\/globals\.css$|app\/v1\/)/,
  /^apps\/web\/src\/app\/.*\/(layout|loading|not-found|error)\.tsx$/,
  /^apps\/api\/src\/[^/]+\.ts$/,
  /^apps\/api\/src\/(auth|db|audit|settings|completions|translations)\//,
  /^apps\/api\/test\/(e2e-server|support\/(auth-app|big-screen|test-db)\.ts$)/,
];
// Files that only list what other files define (routes, error names, exports): lines added here are covered by the
// files that use them; changing or removing a line runs everything.
const WIRING = new Set([
  "apps/api/src/app.ts",
  "apps/api/src/auth/http-errors.ts",
  "packages/shared/src/index.ts",
]);
// Nothing here changes what a browser spec does: only the layout check reads it (a broken image, a migration that
// fails to apply) or the player app uses it.
const LAYOUT_ONLY = [/^apps\/api\/migrations\//, /^apps\/web\/public\//, /^apps\/api\/src\/home\//];
const MESSAGES = "packages/shared/src/i18n/messages.ts";
const SPEC_FILE = /^apps\/web\/e2e\/([\w-]+)\.spec\.ts$/;
// A helper the specs import (builder, mail, nav, paths, layout): only the specs that import it, even through another
// helper, are affected. Anything else under apps/web/e2e is treated as shared.
const SUPPORT_FILE = /^apps\/web\/e2e\/([\w-]+)\.ts$/;

/**
 * Which browser specs (file stems under apps/web/e2e) cover each area. A path or a text key that matches a pattern
 * runs those specs. scripts/ci-scope.test.ts fails when a spec is named by no area, so a new spec is added here.
 */
export const AREAS = [
  [/change-?sets?/i, ["change-sets"]],
  [
    /use-?confirmation|confirmations/i,
    ["confirmations", "organizers", "maps", "finale", "survey-results", "sign-in"],
  ],
  [/announcement/i, ["announcements"]],
  [/session|agenda/i, ["sessions"]],
  [/(^|[^a-z])maps?([^a-z]|$)|maps?-?(panel|board|editor|pin|view)/i, ["maps"]],
  [/sponsor/i, ["sponsors"]],
  [/quest-?ratings?|questscore|\/ratings\//i, ["survey-results"]],
  [/boost|flash/i, ["flash-boosts", "control-room"]],
  [
    /control(-?room|-?parts)?(\/|\.|$)|useQuestLiveActions|useReturnFocus|announcement-?sender|useAnnouncementPress/i,
    ["control-room"],
  ],
  [/modal/i, ["modal"]],
  [/push/i, ["announcements", "invitations", "push-defaults"]],
  [/ranking-?switch/i, ["events"]],
  [/activation/i, ["events", "rehearsal", "souvenirs"]],
  [/\[lang\]\/account\//, ["delete-account", "password"]],
  [/audience|exclusion|guests/i, ["audience"]],
  [/award/i, ["awards"]],
  [/screen/i, ["big-screen", "finale", "cheers", "stations"]],
  [/cheer/i, ["cheers"]],
  [/finale/i, ["finale"]],
  [/codes/i, ["codes"]],
  [/community/i, ["community"]],
  [/daily|console[-/]?content|word-?list|question-?bank/i, ["console-daily"]],
  [/questify/i, ["console-questify", "console-seasons"]],
  [/season/i, ["console-seasons"]],
  [
    /console-?(shell|event|queue)/i,
    ["console-daily", "console-questify", "console-seasons", "console-tickets", "invitations"],
  ],
  [/ticket|help-?desk/i, ["console-tickets", "help-desk"]],
  [/delet(e|ion)/i, ["delete-account"]],
  [/device|kiosk|pairing|\/pair\//i, ["kiosks", "stations", "big-screen"]],
  [
    /events?-?(form|fields|panel|feature|words|card|rules)|\/events\.ts|api\/src\/events\/|events\/new/i,
    ["events", "event-page", "duplicate-event", "confirmations"],
  ],
  [/duplicate-?event|event-?duplicat|copy-?setup/i, ["duplicate-event"]],
  [/branding|accent-?(picker|colou?r)|preview|player-?view|event-?feature-?switch/i, ["branding"]],
  [/app\/\[lang\]\/e\//i, ["event-page", "terms"]],
  [/first-?bonus/i, ["first-bonus"]],
  [/flag|moderation/i, ["flags"]],
  [/games?(-?fields)?\b|games\//i, ["games"]],
  [/hint/i, ["hidden-hint"]],
  [/invit/i, ["invitations"]],
  [/join/i, ["join-requests", "terms"]],
  [/opt-?out/i, ["opt-out"]],
  [/location|coordinates|cities|place-?fields/i, ["location"]],
  [/meet/i, ["meet"]],
  [/nfc/i, ["nfc-tags"]],
  [/operator/i, ["operators"]],
  [
    /organizer(?!s\/\[organizerid\]|id\])|team-?panel|\/team\/|contact|\(workspace\)/i,
    ["organizers", "navigation"],
  ],
  [/\[eventId\]\/page\.tsx$/, ["events", "rehearsal"]],
  [/\[lang\]\/q\//, ["codes"]],
  [/\[lang\]\/s\//, ["stations"]],
  [/\[lang\]\/t\//, ["nfc-tags"]],
  [/\[lang\]\/i\//, ["invitations"]],
  [/\[lang\]\/op\//, ["operators"]],
  [/passport/i, ["passport"]],
  [/password|forgot|reset/i, ["password", "sign-in"]],
  [/players?(-?panel)?\b|player-?awards/i, ["players"]],
  [/poll|vote/i, ["live-polls", "vote-quiz"]],
  [/prize|results?(-?panel)?\b|shop/i, ["prizes", "shop-window"]],
  [/plays\//i, ["games", "meet", "survey-share", "vote-quiz", "live-polls"]],
  [
    /quest(?!ify)/i,
    [
      "quests",
      "quest-items",
      "live-polls",
      "vote-quiz",
      "hidden-hint",
      "games",
      "location",
      "meet",
      "first-bonus",
      "passport",
      "survey-share",
    ],
  ],
  [/rehearsal/i, ["rehearsal"]],
  [/reward/i, ["rewards"]],
  [/sign-?(in|up|out)|code-?step/i, ["sign-in", "password", "organizers"]],
  [/souvenir/i, ["souvenirs"]],
  [/streak/i, ["streak"]],
  [/submission/i, ["submissions"]],
  [/survey/i, ["survey-share", "survey-results"]],
  [/terms|acceptance|accept-?all|legal/i, ["terms", "organizers"]],
  [/nav|language-?switch/i, ["navigation", "organizers"]],
];

function specsFor(subject) {
  return AREAS.filter(([pattern]) => pattern.test(subject)).flatMap(([, specs]) => specs);
}

/** Each message key with the lines of its entry, from the text of messages.ts (a line at column 0 ends the last). */
function messageEntries(text) {
  const entries = new Map();
  let key;
  for (const line of text.split("\n")) {
    const start = /^ {2}"([^"]+)": /.exec(line);
    key = /^[^ ]/.test(line) ? undefined : (start?.[1] ?? key);
    if (key !== undefined) {
      entries.set(key, entries.has(key) ? `${entries.get(key)}\n${line}` : line);
    }
  }
  return entries;
}

/** Message keys whose text changed or was removed; a new key cannot change a page that does not use it. */
export function changedMessageKeys(before, after) {
  const now = messageEntries(after);
  return [...messageEntries(before)]
    .filter(([key, text]) => now.get(key) !== text)
    .map(([key]) => key);
}

/** The specs that import a support file of apps/web/e2e, directly or through another support file. */
export function importersIn(sources, helper) {
  const specs = new Set();
  const seen = new Set([helper]);
  const queue = [helper];
  while (queue.length > 0) {
    const name = queue.pop();
    for (const [other, text] of sources) {
      if (!seen.has(other) && text.includes(`#e2e/${name}.ts`)) {
        seen.add(other);
        if (other.endsWith(".spec")) {
          specs.add(other.slice(0, -".spec".length));
        } else {
          queue.push(other);
        }
      }
    }
  }
  return [...specs];
}

function classifySupport(file, context) {
  const helper = SUPPORT_FILE.exec(file)?.[1];
  const specs = helper === undefined ? undefined : context.importersOf(helper);
  return specs === undefined ? { full: `${file} is shared code` } : { specs };
}

function classifyMessages(keys) {
  if (keys === undefined) {
    return { full: "the text of messages.ts could not be compared" };
  }
  const shared = keys.find((key) => specsFor(key).length === 0);
  return shared === undefined
    ? { specs: keys.flatMap(specsFor) }
    : { full: `the shared text "${shared}" changed` };
}

function classify(file, context) {
  const spec = SPEC_FILE.exec(file);
  if (spec !== null) {
    return { specs: [spec[1]] };
  }
  if (SUPPORT_FILE.test(file)) {
    return classifySupport(file, context);
  }
  if (WIRING.has(file)) {
    return context.additive.has(file)
      ? { specs: [] }
      : { full: `${file} was edited, not only added to` };
  }
  if (SHARED.some((pattern) => pattern.test(file))) {
    return { full: `${file} is shared code` };
  }
  if (file === MESSAGES) {
    return classifyMessages(context.messageKeys);
  }
  if (LAYOUT_ONLY.some((pattern) => pattern.test(file))) {
    return { specs: [] };
  }
  const specs = specsFor(file);
  return specs.length > 0 ? { specs } : { full: `${file} belongs to no area` };
}

/**
 * The browser specs a change needs: `{ all: true, reason }` for the whole suite, or `{ all: false, specs }` with the
 * layout check and the specs of each changed area. `context.messageKeys` are the changed keys of messages.ts (undefined
 * when they could not be read); `context.additive` is the set of changed files whose diff only adds lines.
 */
export function planBrowserSpecs(files, context) {
  const picked = new Set();
  for (const file of files.filter((name) => matches(E2E, name))) {
    const verdict = classify(file, context);
    if (verdict.full !== undefined) {
      return { all: true, reason: verdict.full };
    }
    verdict.specs.forEach((stem) => picked.add(stem));
  }
  LAYOUT_SPECS.forEach((stem) => picked.delete(stem));
  if (picked.size > MAX_AREA_SPECS) {
    return { all: true, reason: `${picked.size} specs across the changed areas` };
  }
  return { all: false, specs: [...LAYOUT_SPECS, ...[...picked].toSorted()] };
}

function matches(patterns, file) {
  return !TEST_FILE.test(file) && patterns.some((pattern) => pattern.test(file));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The changed files and which of them only gained lines, or undefined when the base is missing or unknown. */
function changesSince(base) {
  if (base === undefined || base === "" || /^0+$/.test(base)) {
    return undefined;
  }
  try {
    const rows = git([
      "-c",
      "core.quotepath=false",
      "diff",
      "--numstat",
      "--no-renames",
      `${base}...HEAD`,
    ])
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("\t"));
    return {
      files: rows.map(([, , file]) => file),
      additive: new Set(rows.filter(([, deleted]) => deleted === "0").map(([, , file]) => file)),
    };
  } catch {
    return undefined;
  }
}

function messageKeysSince(base) {
  try {
    const origin = git(["merge-base", base, "HEAD"]).trim();
    return changedMessageKeys(
      git(["show", `${origin}:${MESSAGES}`]),
      git(["show", `HEAD:${MESSAGES}`]),
    );
  } catch {
    return undefined;
  }
}

/** The `web`, `e2e` and `specs` output lines, plus the reason for the choice. */
export function scopeOutput(changes, base, root) {
  const files = changes?.files;
  const touches = (patterns) =>
    files === undefined || files.some((file) => matches(patterns, file));
  const web = touches(WEB);
  const e2e = touches(E2E);
  const lines = (specs) => [`web=${web}`, `e2e=${e2e}`, `specs=${specs}`, ""].join("\n");
  if (!e2e) {
    return { lines: lines(""), reason: "no browser specs: nothing they cover changed" };
  }
  const plan =
    files === undefined ? UNKNOWN : planBrowserSpecs(files, contextOf(changes, base, root));
  if (plan.all) {
    return { lines: lines("all"), reason: `all browser specs: ${plan.reason}` };
  }
  const existing = plan.specs.filter((stem) =>
    existsSync(join(root, "apps", "web", "e2e", `${stem}.spec.ts`)),
  );
  return {
    lines: lines(existing.map((stem) => `e2e/${stem}.spec.ts`).join(" ")),
    reason: `browser specs: ${existing.join(", ")}`,
  };
}

const UNKNOWN = { all: true, reason: "the changed files are unknown" };

function e2eSources(root) {
  const dir = join(root, "apps", "web", "e2e");
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => [name.slice(0, -".ts".length), readFileSync(join(dir, name), "utf8")]),
  );
}

function contextOf(changes, base, root) {
  const messageKeys = changes.files.includes(MESSAGES) ? messageKeysSince(base) : [];
  const sources = e2eSources(root);
  return {
    messageKeys,
    additive: changes.additive,
    importersOf: (helper) => (sources.has(helper) ? importersIn(sources, helper) : []),
  };
}

function main(base) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { lines, reason } = scopeOutput(changesSince(base), base, root);
  process.stderr.write(`${reason}\n`);
  process.stdout.write(lines);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv[2]);
}
