import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AREAS,
  LAYOUT_SPECS,
  MAX_AREA_SPECS,
  changedMessageKeys,
  importersIn,
  planBrowserSpecs,
  scopeOutput,
} from "./ci-scope.mjs";

const ROOT = join(import.meta.dirname, "..");
const E2E_DIR = join(ROOT, "apps", "web", "e2e");
const SOURCES = new Map(
  readdirSync(E2E_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [name.slice(0, -".ts".length), readFileSync(join(E2E_DIR, name), "utf8")]),
);
const noImporters = () => [] as string[];
const importersOf = (helper: string) => importersIn(SOURCES, helper);
const entry = (key: string, en: string) =>
  `  "${key}": {\n    ar: "عربي",\n    en: "${en}",\n  },\n`;
const messagesFile = (...entries: string[]) =>
  `export const MESSAGES = {\n${entries.join("")}} as const;\n`;

function plan(files: string[], context: Record<string, unknown> = {}) {
  return planBrowserSpecs(files, {
    messageKeys: [],
    additive: new Set<string>(),
    importersOf: noImporters,
    ...context,
  });
}

describe("the area table", () => {
  const specStems = readdirSync(E2E_DIR)
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => name.slice(0, -".spec.ts".length));
  const named = new Set([
    ...LAYOUT_SPECS,
    ...AREAS.flatMap(([, specs]: [RegExp, string[]]) => specs),
  ]);

  it("names every browser spec, so a new spec cannot be left out of a scoped run", () => {
    expect(specStems.filter((stem) => !named.has(stem))).toEqual([]);
  });

  it("names only specs that exist", () => {
    expect([...named].filter((stem) => !specStems.includes(stem))).toEqual([]);
  });
});

describe("planBrowserSpecs", () => {
  it("runs the layout check and the specs of the changed area for a panel and its text", () => {
    const result = plan(
      [
        "apps/web/src/components/AnnouncementsPanel.tsx",
        "apps/web/src/lib/announcements.ts",
        "apps/api/src/announcements/routes.ts",
      ],
      { messageKeys: [] },
    );

    expect(result).toEqual({
      all: false,
      specs: [...LAYOUT_SPECS, "announcements"],
    });
  });

  it("runs the specs named by each changed area, once each, sorted", () => {
    const result = plan([
      "apps/web/src/components/StreakPanel.tsx",
      "apps/web/src/components/SouvenirForm.tsx",
      "apps/web/src/components/SouvenirCard.tsx",
    ]);

    expect(result).toEqual({ all: false, specs: [...LAYOUT_SPECS, "souvenirs", "streak"] });
  });

  it("runs a changed spec by itself", () => {
    expect(plan(["apps/web/e2e/modal.spec.ts"])).toEqual({
      all: false,
      specs: [...LAYOUT_SPECS, "modal"],
    });
  });

  it("runs only the layout check for a change the specs do not read", () => {
    const result = plan([
      "apps/api/migrations/0090_new_table.sql",
      "apps/web/public/brand/icon.png",
      "apps/api/src/home/routes.ts",
    ]);

    expect(result).toEqual({ all: false, specs: [...LAYOUT_SPECS] });
  });

  it.each([
    ["the shared interface kit", "apps/web/src/ui/Button.tsx"],
    ["a stylesheet of the kit", "apps/web/src/ui/form.module.css"],
    ["the global stylesheet", "apps/web/src/app/globals.css"],
    ["a layout", "apps/web/src/app/[lang]/console/layout.tsx"],
    ["the Playwright config", "apps/web/playwright.config.ts"],
    ["the web package", "apps/web/package.json"],
    ["the lockfile", "pnpm-lock.yaml"],
    ["a workflow", ".github/workflows/ci.yml"],
    ["this script", "scripts/ci-scope.mjs"],
    ["the API's composition root", "apps/api/src/config.ts"],
    ["the sign-in code", "apps/api/src/auth/session.ts"],
    ["the database layer", "apps/api/src/db/pool.ts"],
    ["the e2e server", "apps/api/test/e2e-server.ts"],
    ["a component no area names", "apps/web/src/components/ConfirmDialog.tsx"],
    ["a shared package file", "packages/shared/src/errors.ts"],
  ])("runs the whole suite for %s", (_name, file) => {
    expect(plan([file, "apps/web/src/components/StreakPanel.tsx"])).toEqual({
      all: true,
      reason: expect.stringContaining(file),
    });
  });

  it("runs the whole suite when the changed areas need more specs than the cap", () => {
    const wide = plan([
      "apps/web/src/components/QuestForm.tsx",
      "apps/web/src/components/ConsoleShell.tsx",
      "apps/web/src/components/SouvenirForm.tsx",
      "apps/web/src/components/StreakPanel.tsx",
      "apps/web/src/components/TeamPanel.tsx",
      "apps/web/src/components/TermsScope.tsx",
    ]);

    expect(wide).toEqual({ all: true, reason: "21 specs across the changed areas" });
    expect(MAX_AREA_SPECS).toBe(20);
  });

  it("does not start a browser run for a unit test file", () => {
    const output = scopeOutput(
      { files: ["apps/api/src/announcements/store.test.ts"], additive: new Set<string>() },
      "base",
      ROOT,
    );

    expect(output.lines).toBe("web=false\ne2e=false\nspecs=\n");
  });

  it("lets lines be added to the files that only list routes, errors and exports", () => {
    const files = [
      "apps/api/src/app.ts",
      "apps/api/src/auth/http-errors.ts",
      "packages/shared/src/index.ts",
      "apps/api/src/announcements/routes.ts",
    ];

    expect(plan(files, { additive: new Set(files) })).toEqual({
      all: false,
      specs: [...LAYOUT_SPECS, "announcements"],
    });
    expect(plan(files, { additive: new Set(files.slice(1)) })).toEqual({
      all: true,
      reason: "apps/api/src/app.ts was edited, not only added to",
    });
  });

  it("runs the specs that import a changed e2e helper, through other helpers too", () => {
    const layoutHelper = plan(["apps/web/e2e/layout.ts"], { importersOf });
    expect(layoutHelper).toEqual({ all: false, specs: [...LAYOUT_SPECS, "navigation"] });

    expect(plan(["apps/web/e2e/builder.ts"], { importersOf })).toEqual({
      all: true,
      reason: expect.stringMatching(/^\d+ specs across the changed areas$/),
    });
  });
});

describe("messages.ts", () => {
  it("lists changed and removed keys, and not new ones", () => {
    const before = messagesFile(
      entry("finale.title", "Finale"),
      entry("nav.home", "Home"),
      entry("a.b", "Old"),
    );
    const after = messagesFile(
      entry("finale.title", "The finale"),
      entry("a.b", "Old"),
      entry("new.key", "New"),
    );

    expect(changedMessageKeys(before, after)).toEqual(["finale.title", "nav.home"]);
  });

  it("sees a change on a line below the key", () => {
    const before = messagesFile(entry("quests.title", "Quests"));
    const after = messagesFile(entry("quests.title", "Challenges"));

    expect(changedMessageKeys(before, after)).toEqual(["quests.title"]);
  });

  it("runs the specs of the area whose text changed", () => {
    expect(
      plan(["packages/shared/src/i18n/messages.ts"], { messageKeys: ["finale.title"] }),
    ).toEqual({
      all: false,
      specs: [...LAYOUT_SPECS, "finale"],
    });
  });

  it("runs only the layout check when keys were only added", () => {
    expect(plan(["packages/shared/src/i18n/messages.ts"], { messageKeys: [] })).toEqual({
      all: false,
      specs: [...LAYOUT_SPECS],
    });
  });

  it("runs everything when the changed text belongs to no area, or cannot be compared", () => {
    expect(
      plan(["packages/shared/src/i18n/messages.ts"], { messageKeys: ["common.save"] }),
    ).toEqual({
      all: true,
      reason: 'the shared text "common.save" changed',
    });
    expect(plan(["packages/shared/src/i18n/messages.ts"], { messageKeys: undefined }).all).toBe(
      true,
    );
  });
});

describe("scopeOutput", () => {
  it("runs everything when the changed files are unknown", () => {
    expect(scopeOutput(undefined, "", ROOT)).toEqual({
      lines: "web=true\ne2e=true\nspecs=all\n",
      reason: "all browser specs: the changed files are unknown",
    });
  });

  it("lists the specs as paths from apps/web, and builds the web app for a web change", () => {
    const output = scopeOutput(
      { files: ["apps/web/src/components/StreakPanel.tsx"], additive: new Set<string>() },
      "base",
      ROOT,
    );

    expect(output.lines).toBe(
      "web=true\ne2e=true\nspecs=e2e/layout.spec.ts e2e/layout-check.spec.ts e2e/streak.spec.ts\n",
    );
  });

  it("builds nothing for a docs-only change", () => {
    const output = scopeOutput(
      { files: ["docs/RUNBOOK.md"], additive: new Set<string>() },
      "base",
      ROOT,
    );

    expect(output.lines).toBe("web=false\ne2e=false\nspecs=\n");
  });

  it("skips a spec that was deleted", () => {
    const output = scopeOutput(
      { files: ["apps/web/e2e/gone.spec.ts"], additive: new Set<string>() },
      "base",
      ROOT,
    );

    expect(output.lines).toBe(
      "web=true\ne2e=true\nspecs=e2e/layout.spec.ts e2e/layout-check.spec.ts\n",
    );
  });
});

const IDENTITY = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.test",
  "-c",
  "core.autocrlf=false",
];
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", [...IDENTITY, ...args], { cwd: repo, encoding: "utf8" });
const write = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const run = (repo: string, base: string) =>
  execFileSync("node", [join(ROOT, "scripts", "ci-scope.mjs"), base], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

describe("the command", () => {
  it("reads the diff: added lines to a wiring file ride along, an edited line runs everything", () => {
    const repo = mkdtempSync(join(tmpdir(), "ci-scope-"));
    try {
      git(repo, "init", "--quiet");
      write(repo, "apps/api/src/app.ts", "one\ntwo\n");
      write(repo, "apps/web/src/components/StreakPanel.tsx", "a\n");
      git(repo, "add", ".");
      git(repo, "commit", "--quiet", "-m", "start");
      const base = git(repo, "rev-parse", "HEAD").trim();

      write(repo, "apps/api/src/app.ts", "one\ntwo\nthree\n");
      write(repo, "apps/web/src/components/StreakPanel.tsx", "b\n");
      git(repo, "commit", "--quiet", "-am", "added");
      expect(run(repo, base)).toBe(
        "web=true\ne2e=true\nspecs=e2e/layout.spec.ts e2e/layout-check.spec.ts e2e/streak.spec.ts\n",
      );

      write(repo, "apps/api/src/app.ts", "uno\ntwo\nthree\n");
      git(repo, "commit", "--quiet", "-am", "edited");
      expect(run(repo, base)).toBe("web=true\ne2e=true\nspecs=all\n");
      expect(run(repo, "")).toBe("web=true\ne2e=true\nspecs=all\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
