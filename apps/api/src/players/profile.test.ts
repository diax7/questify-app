import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { registerProfileRoutes } from "#src/players/profile";
import type { ConfigResult, SettingsService } from "#src/settings/service";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const SIGNED_IN = { "x-test-player": "yes" };
const NOW = new Date("2030-01-01T00:00:00.000Z");

type Answers = Readonly<{
  level?: FakeAnswer;
  gems?: FakeAnswer;
  marketing?: FakeAnswer;
  marketingError?: Error;
  next?: Date | null;
  rename?: FakeAnswer;
}>;

const levelRow = (nextLevelAt: string | null) => ({
  xp: "120",
  level: 2,
  level_from: "100",
  next_level_at: nextLevelAt,
  title_ar: "مستكشف",
  title_en: "Explorer",
});

let app: FastifyInstance;
let forEvent: ReturnType<typeof vi.fn<SettingsService["forEvent"]>>;

const composed = (
  features: Record<string, unknown>,
  tuning: Record<string, unknown>,
): ConfigResult =>
  ({ kind: "ok", config: { features, tuning }, etag: "e" }) as unknown as ConfigResult;

/** The profile routes over a pool that answers each own_* function from `answers` and a settings service of `config`. */
function build(config: ConfigResult, answers: Answers = {}) {
  const seen: { sql: string; values: readonly unknown[] }[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    if (sql.includes("own_level")) return answers.level ?? { rows: [levelRow("300")] };
    if (sql.includes("own_gems")) return answers.gems ?? { rows: [{ gems: "5" }] };
    if (sql.includes("own_equipment")) {
      return {
        rows: [{ equipment: { character: null, frame: null, title: null }, next_reward: null }],
      };
    }
    if (sql.includes("own_unread_tickets")) return { rows: [{ unread: 0 }] };
    if (sql.includes("own_marketing")) {
      if (answers.marketingError !== undefined) throw answers.marketingError;
      return answers.marketing ?? { rows: [{ r: { channels: {}, asked: false, canOptIn: true } }] };
    }
    if (sql.includes("rename_player")) return answers.rename ?? { rows: [] };
    if (sql.includes("FROM player p")) {
      return {
        rows: [
          {
            username: "sara_k",
            avatar: "falcon",
            next: answers.next ?? null,
            accepted: null,
            phone: null,
            email: null,
          },
        ],
      };
    }
    return { rows: [] };
  });
  forEvent = vi.fn<SettingsService["forEvent"]>(async () => config);
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-player"] !== undefined) request.player = { id: PLAYER };
  });
  registerProfileRoutes(app, { pool, settings: { forEvent } as unknown as SettingsService });
  return { seen };
}

const getMe = () => app.inject({ method: "GET", url: "/v1/me", headers: SIGNED_IN });
const patchMe = (payload: object) =>
  app.inject({ method: "PATCH", url: "/v1/me", headers: SIGNED_IN, payload });
const nextChangeDays = (seen: { sql: string; values: readonly unknown[] }[]) =>
  seen.find((one) => one.sql.includes("username_next_change"))?.values[1];

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe("GET /v1/me: the Questify level", () => {
  it("carries the next level's threshold as a number", async () => {
    build(composed({}, {}));
    const body = (await getMe()).json();
    expect(body.questify).toMatchObject({ xp: 120, levelFrom: 100, nextLevelAt: 300 });
  });

  it("carries a null threshold at the top level, not zero", async () => {
    build(composed({}, {}), { level: { rows: [levelRow(null)] } });
    expect((await getMe()).json().questify.nextLevelAt).toBeNull();
  });
});

describe("GET /v1/me: the marketing step", () => {
  it("says whether the consent step was answered and whether the player may opt in, and no more", async () => {
    build(composed({}, {}), {
      marketing: {
        rows: [
          {
            r: {
              channels: { sms: { optedIn: true, changedAt: "2030-01-01T00:00:00Z" } },
              asked: true,
              canOptIn: false,
            },
          },
        ],
      },
    });
    expect((await getMe()).json().marketing).toEqual({ asked: true, canOptIn: false });
  });

  it("answers 401 when the database says the caller is not an active player", async () => {
    build(composed({}, {}), { marketingError: pgError({ code: "PI401" }) });
    expect((await getMe()).statusCode).toBe(401);
  });
});

describe("GET /v1/me: the gem balance", () => {
  it("answers the balance as a number", async () => {
    build(composed({}, {}), { gems: { rows: [{ gems: "12" }] } });
    expect((await getMe()).json().gems).toBe(12);
  });

  it.each([
    ["no row", { rows: [] }],
    ["a null balance", { rows: [{ gems: null }] }],
  ])("answers 401 for %s", async (_name, gems) => {
    build(composed({}, {}), { gems });
    const response = await getMe();
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
  });
});

describe("the username-change rules", () => {
  it("allows a change when the switch is on and no wait is running, with the tuned days", async () => {
    const { seen } = build(
      composed({ usernameChanges: { enabled: true } }, { usernameChangeDays: 7 }),
    );
    const body = (await getMe()).json();
    expect(body.usernameChange).toEqual({ allowed: true, nextChangeAt: null });
    expect(nextChangeDays(seen)).toBe(7);
  });

  it("refuses a change while the wait runs, even with the switch on", async () => {
    build(composed({ usernameChanges: { enabled: true } }, { usernameChangeDays: 7 }), {
      next: NOW,
    });
    const body = (await getMe()).json();
    expect(body.usernameChange).toEqual({ allowed: false, nextChangeAt: NOW.toISOString() });
  });

  it("treats a missing switch as off and a missing tuning as 30 days", async () => {
    const { seen } = build(composed({}, {}));
    const body = (await getMe()).json();
    expect(body.usernameChange.allowed).toBe(false);
    expect(nextChangeDays(seen)).toBe(30);
  });

  it("is off, with 30 days, when the platform configuration does not compose", async () => {
    const { seen } = build({ kind: "event_not_found" });
    const response = await getMe();
    expect(response.statusCode).toBe(200);
    expect(response.json().usernameChange).toEqual({ allowed: false, nextChangeAt: null });
    expect(nextChangeDays(seen)).toBe(30);
  });

  it("answers 403 to a rename when the platform configuration does not compose", async () => {
    build({ kind: "event_not_found" });
    const response = await patchMe({ username: "new_name" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "username_changes_off" });
  });
});

describe("PATCH /v1/me", () => {
  it("reads the settings once, for the answer, when the username is not changed", async () => {
    const { seen } = build(composed({ usernameChanges: { enabled: true } }, {}));
    const response = await patchMe({ avatar: "fox" });
    expect(response.statusCode).toBe(200);
    expect(forEvent).toHaveBeenCalledTimes(1);
    expect(seen.some((one) => one.sql.includes("rename_player"))).toBe(false);
  });

  it("renames with the tuned days when the username is sent", async () => {
    const { seen } = build(
      composed({ usernameChanges: { enabled: true } }, { usernameChangeDays: 9 }),
      { rename: { rows: [{ outcome: "renamed", next_change_at: null }] } },
    );
    const response = await patchMe({ username: "new_name" });
    expect(response.statusCode).toBe(200);
    expect(seen.find((one) => one.sql.includes("rename_player"))?.values).toEqual(["new_name", 9]);
  });

  it("answers 429 with the seconds left in retry-after and the time of the next change", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const next = new Date(NOW.getTime() + 90_500);
    build(composed({ usernameChanges: { enabled: true } }, {}), {
      rename: { rows: [{ outcome: "too_soon", next_change_at: next }] },
    });
    const response = await patchMe({ username: "new_name" });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("91");
    expect(response.json()).toMatchObject({
      code: "username_too_soon",
      details: { nextChangeAt: next.toISOString() },
    });
  });

  it("answers 429 with a one-second retry-after and no time when the database gives none", async () => {
    build(composed({ usernameChanges: { enabled: true } }, {}), {
      rename: { rows: [{ outcome: "too_soon", next_change_at: null }] },
    });
    const response = await patchMe({ username: "new_name" });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json().details.nextChangeAt).toBeNull();
  });
});
