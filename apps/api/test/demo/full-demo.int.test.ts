import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DASHBOARD_ORIGIN,
  PASSWORD,
  createStaff,
  startApp,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";
/** The demo script is plain JavaScript run with node on the server (scripts/demo, docs/demo/PHONE_DEMO.md). */
type Fn = (...args: unknown[]) => Promise<unknown>;
type DemoScript = Readonly<{
  beginSignIn: Fn;
  beginSignUp: Fn;
  finish: Fn;
  createApi: (options: { api: string; origin: string }) => Api;
  playerSmoke: Fn;
  buildDemo: Fn;
  qrSheet: (demo: unknown, options: { web: string }) => string;
}>;
const SCRIPT = new URL("../../../../scripts/demo/", import.meta.url);
async function loadScript(): Promise<DemoScript> {
  const parts = await Promise.all(
    ["auth", "http", "smoke", "run", "print"].map(
      (name) => import(new URL(`lib/${name}.mjs`, SCRIPT).href) as Promise<object>,
    ),
  );
  return Object.assign({}, ...parts) as DemoScript;
}

type Built = Readonly<{
  organizerId: string;
  eventId: string;
  joinCode: string;
  codes: {
    codes: { url: string; title: { en: string }; stepId: string | null }[];
    secrets: unknown[];
  };
  log: string[];
}>;
const run = promisify(execFile);
const CLI = fileURLToPath(new URL("full-demo.mjs", SCRIPT));

type Api = Readonly<{
  call: (...args: unknown[]) => Promise<{ status: number; body: unknown }>;
}>;

/**
 * The full phone demo (scripts/demo): the script builds the demo event over real HTTP on a real listening API, the way it
 * runs against staging, then runs again (nothing new), and a player signs in by email, joins and plays the main kinds.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the full phone demo script", () => {
  let db: TestDatabase;
  let test: TestApp;
  let demo: DemoScript;
  let api: Api;
  let base: string;
  let ownerCookie: string;
  let adminCookie: string;
  let first: Built;

  const signIn = async (email: string): Promise<string> => {
    const pending: unknown = await demo.beginSignIn(api, {
      email,
      password: PASSWORD,
    });
    return (
      (await demo.finish(api, pending, test.mail.lastCode(email))) as {
        cookie: string;
      }
    ).cookie;
  };

  beforeAll(async () => {
    demo = await loadScript();
    db = await createTestDatabase();
    test = await startApp(db);
    await test.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = test.app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    api = demo.createApi({ api: base, origin: DASHBOARD_ORIGIN }) as Api;
    await createStaff(db.owner, { email: "admin@demo.test", admin: true });
    adminCookie = await signIn("admin@demo.test");
    const email = "owner@demo.test";
    const pending: unknown = await demo.beginSignUp(api, {
      email,
      password: PASSWORD,
      organizerName: "Questify Demo Organizer",
    });
    ownerCookie = (
      (await demo.finish(api, pending, test.mail.lastCode(email))) as {
        cookie: string;
      }
    ).cookie;
  });
  afterAll(async () => {
    await test?.close();
    await db?.close();
  });

  it("builds every part of the demo event, activates it and leaves nothing skipped", async () => {
    first = (await demo.buildDemo({ api, ownerCookie, adminCookie })) as Built;
    expect(first.log.filter((line) => line.startsWith("SKIPPED"))).toEqual([]);
    expect(first.log).toContain("activated by the admin, big screen on");
    expect(first.log).toContain("daily word cadence: daily from tomorrow");
    expect(first.log.find((line) => line.startsWith("daily words set:"))).toBeDefined();
    // 3 QR quests (welcome, stage, flash) and 4 passport steps.
    expect(first.codes.codes).toHaveLength(7);
    expect(first.codes.secrets).toHaveLength(1);
    const { rows } = await db.owner.query<{
      status: string;
      quests: number;
      rewards: number;
    }>(
      `SELECT e.status, (SELECT count(*)::int FROM quest q WHERE q.event_id = e.id) AS quests,
              (SELECT count(*)::int FROM reward r WHERE r.event_id = e.id) AS rewards
         FROM event e WHERE e.id = $1`,
      [first.eventId],
    );
    expect(rows[0]).toMatchObject({ quests: 19, rewards: 5 });
    // The sign-up's organizer is the demo organizer: no second one is made.
    const owned = await db.owner.query(
      `SELECT 1 FROM organizer_member m JOIN staff_user u ON u.id = m.staff_user_id
        WHERE u.email = 'owner@demo.test'`,
    );
    expect(owned.rowCount).toBe(1);
  });

  it("changes nothing when run again", async () => {
    const again = (await demo.buildDemo({
      api,
      ownerCookie,
      adminCookie,
    })) as Built;
    expect(again.eventId).toBe(first.eventId);
    expect(again.log.filter((line) => !line.startsWith("activation"))).toEqual([]);
  });

  it("lets a player sign in by email, join and play the main quest kinds", async () => {
    await db.owner.query("UPDATE event SET starts_at = now() - interval '1 minute' WHERE id = $1", [
      first.eventId,
    ]);
    const played = (await demo.playerSmoke(api, {
      email: "player@demo.test",
      joinCode: first.joinCode,
      eventId: first.eventId,
      codes: first.codes,
      readCode: (to: string) => test.mail.lastCode(to),
    })) as { balance: number; done: string[] };
    expect(played.done).toEqual(
      expect.arrayContaining(["scan", "entry code", "passport", "redeem"]),
    );
    expect(played.balance).toBeGreaterThan(0);
  });

  it("prints a QR sheet with the join code and every printed code", () => {
    const html = demo.qrSheet(first, { web: DASHBOARD_ORIGIN }) as string;
    expect(html).toContain(first.joinCode);
    expect(html.match(/<svg/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it("refuses any API that is not the https staging API or this machine, before any request", async () => {
    const out = await mkdtemp(join(tmpdir(), "questify-demo-"));
    for (const api of [
      "https://questify-api-production-x.cranl.net",
      "https://evil-staging.example",
      "http://questify-api-staging-3ez01s.cranl.net",
    ]) {
      const env = {
        ...process.env,
        DEMO_API: api,
        DEMO_OUT: out,
        DEMO_STATE: join(out, "s.json"),
        DEMO_OWNER_EMAIL: "x@demo.test",
      };
      await expect(run(process.execPath, [CLI, "signup"], { env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Refusing"),
      });
    }
    await rm(out, { recursive: true, force: true });
  });

  it("runs from the command line: sign-up, the emailed code, build, and never prints a secret", async () => {
    const out = await mkdtemp(join(tmpdir(), "questify-demo-"));
    const email = "cli-owner@demo.test";
    const env = {
      ...process.env,
      DEMO_API: base,
      DEMO_WEB: DASHBOARD_ORIGIN,
      DEMO_OUT: out,
      DEMO_STATE: join(out, "state.json"),
      DEMO_OWNER_EMAIL: email,
    };
    const cli = async (...args: string[]) =>
      (await run(process.execPath, [CLI, ...args], { env })).stdout;
    expect(await cli("signup")).toContain("A code was emailed");
    const code = test.mail.lastCode(email);
    expect(await cli("code", code)).toContain("Signed in as the owner.");
    const built = await cli("build");
    const state = JSON.parse(await readFile(join(out, "state.json"), "utf8")) as {
      owner: { password: string; cookie: string };
    };
    expect(built).toMatch(/Join code: [A-Z0-9]+/);
    expect(built).toContain("no admin session");
    for (const secret of [state.owner.password, state.owner.cookie.split("=")[1] ?? "x", code]) {
      expect(built).not.toContain(secret);
    }
    expect((await stat(join(out, "state.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(out, "demo-codes.html"), "utf8")).toContain("<svg");
    expect(await cli("logout")).toContain("Signed out.");
    await rm(out, { recursive: true });
  });

  it("builds a new event on reset", async () => {
    const reset = (await demo.buildDemo({
      api,
      ownerCookie,
      adminCookie,
      reset: true,
    })) as Built;
    expect(reset.eventId).not.toBe(first.eventId);
    expect(reset.log[0]).toMatch(/^ended the old demo event/);
  });
});
