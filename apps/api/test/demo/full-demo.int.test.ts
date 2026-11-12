import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  REWARDS: { name: { en: string }; codes?: string[] }[];
}>;
const SCRIPT = new URL("../../../../scripts/demo/", import.meta.url);
async function loadScript(): Promise<DemoScript> {
  const parts = await Promise.all(
    ["auth", "http", "smoke", "run", "print", "content"].map(
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

type Wanted = { name: { en: string }; codes?: string[] } & Record<string, unknown>;
type Reward = { id: string; stock: number; name: { en: string } } & Record<string, unknown>;
type Map_ = { id: string; pins: { id: string }[] };
type Sponsor = { id: string; tags: { kind: string; targetId: string }[] };

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
    first = (await demo.buildDemo({
      api,
      ownerCookie,
      adminCookie,
      dailyWord: true,
    })) as Built;
    expect(first.log.filter((line) => line.startsWith("SKIPPED"))).toEqual([]);
    expect(first.log).toContain("activated by the admin, big screen on");
    expect(
      first.log.find((line) => line.startsWith("daily word cadence: daily from tomorrow")),
    ).toBeDefined();
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

  const owner = (built: Built, method: string, path: string, body?: unknown) =>
    api.call(method, `/v1/organizers/${built.organizerId}/events/${built.eventId}${path}`, {
      cookie: ownerCookie,
      expect: [200, 201, 204],
      ...(body === undefined ? {} : { body }),
    });

  it("tops up a map pin and a sponsor tag a rerun finds missing", async () => {
    const maps = ((await owner(first, "GET", "/maps")).body as { maps: Map_[] }).maps;
    const pins = maps[0]?.pins ?? [];
    await owner(first, "DELETE", `/maps/${maps[0]?.id}/pins/${pins[0]?.id}`);
    const sponsors = ((await owner(first, "GET", "/sponsors")).body as { sponsors: Sponsor[] })
      .sponsors;
    const tagged = sponsors.find((x) => x.tags.length > 0) as Sponsor;
    await owner(first, "PUT", "/sponsor-tags", {
      kind: tagged.tags[0]?.kind,
      targetId: tagged.tags[0]?.targetId,
      sponsorId: null,
    });
    const again = (await demo.buildDemo({ api, ownerCookie, adminCookie })) as Built;
    expect(again.log.filter((line) => line.startsWith("SKIPPED"))).toEqual([]);
    expect(again.log).toContain("map Hall map: added 1 missing pins");
    expect(again.log.some((line) => line.includes("tagged on"))).toBe(true);
    // Once complete, a rerun changes nothing (not even the shop settings).
    const quiet = (await demo.buildDemo({ api, ownerCookie, adminCookie })) as Built;
    expect(quiet.log.filter((line) => !line.startsWith("activation"))).toEqual([]);
  });

  it("changes the staging-wide daily word cadence only with the explicit flag", async () => {
    await api.call("PUT", "/v1/admin/daily/cadence", {
      cookie: adminCookie,
      body: { kind: "word", cadence: "weekly" },
    });
    const without = (await demo.buildDemo({ api, ownerCookie, adminCookie })) as Built;
    expect(without.log.some((line) => line.includes("was left alone"))).toBe(true);
    expect(without.log.some((line) => line.startsWith("daily word cadence"))).toBe(false);
    const view = (
      await api.call("GET", "/v1/admin/daily?from=2030-01-01&to=2030-01-02", {
        cookie: adminCookie,
      })
    ).body as { status: { word: { cadence: string; next: unknown } } };
    expect(view.status.word.cadence).toBe("weekly");
    expect(view.status.word.next ?? null).toBeNull();
    const withFlag = (await demo.buildDemo({
      api,
      ownerCookie,
      adminCookie,
      dailyWord: true,
    })) as Built;
    expect(withFlag.log).toContain("daily word cadence: daily from tomorrow (was weekly)");
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
    for (const target of [
      "https://questify-api-production-x.cranl.net",
      "https://evil-staging.example",
      "http://questify-target-staging-3ez01s.cranl.net",
    ]) {
      const env = {
        ...process.env,
        DEMO_API: target,
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

  it("exits 1 when a step is SKIPPED, then a rerun tops up the half-built map and exits 0", async () => {
    const out = await mkdtemp(join(tmpdir(), "questify-demo-"));
    const email = "cli-skip@demo.test";
    // A relay to the real API that refuses every map pin: the map is made, its pins are not.
    const relay: Server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        if (request.method === "POST" && /\/maps\/[^/]+\/pins$/.test(request.url ?? "")) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end('{"code":"internal"}');
          return;
        }
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(
            ([name]) => !["host", "connection", "content-length"].includes(name),
          ),
        ) as Record<string, string>;
        const upstream = await fetch(`${base}${request.url}`, {
          method: request.method ?? "GET",
          headers,
          ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
        });
        const cookies = upstream.headers.getSetCookie();
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          ...(cookies.length === 0 ? {} : { "set-cookie": cookies }),
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      })();
    });
    await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
    const relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
    const env = {
      ...process.env,
      DEMO_WEB: DASHBOARD_ORIGIN,
      DEMO_OUT: out,
      DEMO_STATE: join(out, "state.json"),
      DEMO_OWNER_EMAIL: email,
    };
    const cli = (target: string, ...args: string[]) =>
      run(process.execPath, [CLI, ...args], { env: { ...env, DEMO_API: target } });
    try {
      await cli(base, "signup");
      await cli(base, "code", test.mail.lastCode(email));
      await expect(cli(relayBase, "build")).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("SKIPPED map"),
        stderr: expect.stringContaining("SKIPPED"),
      });
      // The sheet is still written, and no temporary state file is left behind.
      expect(await readFile(join(out, "demo-codes.html"), "utf8")).toContain("<svg");
      expect((await readdir(out)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      const rerun = await cli(base, "build");
      expect(rerun.stdout).toMatch(/map Hall map: added \d+ missing pins/);
      expect(rerun.stdout).not.toContain("SKIPPED");
    } finally {
      relay.close();
    }
    await rm(out, { recursive: true });
  });

  it("stops with 'state file unreadable' when the state file is not JSON", async () => {
    const out = await mkdtemp(join(tmpdir(), "questify-demo-"));
    await writeFile(join(out, "state.json"), "{ not json", { mode: 0o600 });
    const env = {
      ...process.env,
      DEMO_API: base,
      DEMO_OUT: out,
      DEMO_STATE: join(out, "state.json"),
      DEMO_OWNER_EMAIL: "x@demo.test",
    };
    await expect(run(process.execPath, [CLI, "logout"], { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("state file unreadable"),
    });
    await rm(out, { recursive: true });
  });

  it("shows only whitelisted, plain error details", async () => {
    const odd: Server = createServer((_request, response) => {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: "invalid_reward",
          details: { field: "price", email: "someone@example.com", reason: "has spaces in it" },
        }),
      );
    });
    await new Promise<void>((done) => odd.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(odd.address() as AddressInfo).port}`;
    try {
      const probe = demo.createApi({ api: url, origin: DASHBOARD_ORIGIN });
      const error = await probe.call("GET", "/x").catch((caught: Error) => caught);
      expect((error as Error).message).toBe("GET /x answered 422 invalid_reward (field=price)");
    } finally {
      odd.close();
    }
  });

  it("tops up the reward codes of a reward whose upload failed, on a rerun", async () => {
    // A build that dies while loading the Bookstore reward's codes (a reset, so a new event) ...
    const failing = {
      ...api,
      call: (method: string, path: string, options?: { body?: { codes?: string[] } }) =>
        method === "POST" && path.endsWith("/codes") && options?.body?.codes?.[0]?.includes("BOOK")
          ? Promise.reject(new Error("simulated failure"))
          : api.call(method, path, options),
    } as Api;
    await expect(
      demo.buildDemo({ api: failing, ownerCookie, adminCookie, reset: true }),
    ).rejects.toThrow("simulated failure");
    // ... leaves the reward with no codes; a plain rerun loads them and says so.
    const rerun = (await demo.buildDemo({ api, ownerCookie, adminCookie })) as Built;
    const book = demo.REWARDS.find((r) => r.name.en === "Bookstore 10% off") as Wanted;
    expect(rerun.log).toContain(`reward Bookstore 10% off: topped up ${book.codes?.length} codes`);
    expect(rerun.log.filter((line) => line.startsWith("SKIPPED"))).toEqual([]);
    // The event has started by the time anyone resets it: only a live event can be ended.
    await db.owner.query("UPDATE event SET starts_at = now() - interval '1 minute' WHERE id = $1", [
      rerun.eventId,
    ]);
    const { rewards } = (await owner(rerun, "GET", "/rewards")).body as { rewards: Reward[] };
    expect(rewards.find((r) => r.name.en === "Bookstore 10% off")?.stock).toBe(book.codes?.length);
  });

  it("builds a new event on reset", async () => {
    const reset = (await demo.buildDemo({
      api,
      ownerCookie,
      adminCookie,
      reset: true,
    })) as Built;
    expect(reset.eventId).not.toBe(first.eventId);
    expect(reset.log[0]).toMatch(/^ended the old demo event \S+ \(answered 2\d\d\)$/);
  });

  it("stops a reset that cannot end the old event, and builds nothing new", async () => {
    // The event the last test built has not started yet: the end route refuses it (409).
    const before = await db.owner.query("SELECT count(*)::int AS n FROM event");
    await expect(demo.buildDemo({ api, ownerCookie, adminCookie, reset: true })).rejects.toThrow(
      /--reset stopped.*409/,
    );
    const after = await db.owner.query("SELECT count(*)::int AS n FROM event");
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
