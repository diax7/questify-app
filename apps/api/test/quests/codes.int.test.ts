import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQuestCodeKey, verifyQuestCode } from "#src/quests/qr";
import {
  DASHBOARD_ORIGIN,
  createStaff,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Code = {
  questId: string;
  categoryId: string;
  title: { ar: string | null; en: string | null };
  version: number;
  url: string;
};

const EVENT = {
  name: { en: "Najd Meetup" },
  timezone: "Asia/Riyadh",
  startsAt: "2030-11-01T09:00",
  endsAt: "2030-11-01T17:00",
};
const KEY = createQuestCodeKey(testConfig().qrSecret);
const key = () => ({ "idempotency-key": `k-${Math.random()}` });
const tokenOf = (url: string) => url.slice(`${DASHBOARD_ORIGIN}/q/`.length);

describe.skipIf(TEST_DATABASE_URL === undefined)("quest QR codes (T-104)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    cookie: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, headers),
      ...(payload === undefined ? {} : { payload }),
    });

  /** A new organizer with a signed-in owner, one draft event, and the paths under it. */
  const newEvent = async () => {
    counter += 1;
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', $1) RETURNING id",
      [`codes-${counter}`],
    );
    const orgId = org?.id ?? "";
    const email = `owner${counter}@codes.test`;
    const staff = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [orgId, staff],
    );
    const cookie = await signInFully(test, email);
    const made = await call("POST", `/v1/organizers/${orgId}/events`, cookie, EVENT, key());
    const eventId = made.json<{ event: { id: string } }>().event.id;
    const base = `/v1/organizers/${orgId}/events/${eventId}`;
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      eventId,
    ]);
    return { orgId, eventId, cookie, base, general: general?.id ?? "" };
  };
  type Setup = Awaited<ReturnType<typeof newEvent>>;

  const addQuest = async (s: Setup, extra: object = {}): Promise<string> => {
    const response = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      {
        categoryId: s.general,
        type: "scan_qr",
        title: { en: "Find the stage" },
        points: 10,
        ...extra,
      },
      key(),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ quest: { id: string } }>().quest.id;
  };
  const codes = async (s: Setup) =>
    (await call("GET", `${s.base}/codes`, s.cookie)).json<{ codes: Code[] }>().codes;
  const currentVersion = async (questId: string) =>
    (
      await owner<{ qr_version: number }>("SELECT qr_version FROM quest WHERE id = $1", [questId])
    )[0]?.qr_version;

  describe("listing", () => {
    it("gives one signed code per QR quest, in the builder's order, pointing at the /q/ page", async () => {
      const s = await newEvent();
      const first = await addQuest(s, { title: { ar: "المسرح" } });
      await addQuest(s, {
        type: "enter_code",
        title: { en: "Code" },
        config: { code: "NAJD2030" },
      });
      const second = await addQuest(s);
      const list = await codes(s);
      expect(list.map((code) => code.questId)).toEqual([first, second]);
      expect(list[0]).toMatchObject({
        categoryId: s.general,
        category: { ar: "عام", en: "General" },
        title: { ar: "المسرح", en: null },
        version: 1,
      });
      for (const code of list) {
        expect(code.url.startsWith(`${DASHBOARD_ORIGIN}/q/`)).toBe(true);
        expect(verifyQuestCode(KEY, tokenOf(code.url), code.questId)).toEqual({
          kind: "valid",
          questId: code.questId,
          version: 1,
        });
      }
    });

    it("lists nothing for an event without QR quests, and 404 for another organizer's event", async () => {
      const s = await newEvent();
      const other = await newEvent();
      expect(await codes(s)).toEqual([]);
      const response = await call(
        "GET",
        `/v1/organizers/${s.orgId}/events/${other.eventId}/codes`,
        s.cookie,
      );
      expect(response.statusCode).toBe(404);
    });
  });

  describe("regenerating (FR-1711)", () => {
    it("bumps the version, so the code printed before no longer matches, and audits only the versions", async () => {
      const s = await newEvent();
      const quest = await addQuest(s);
      const [before] = await codes(s);
      const response = await call("POST", `${s.base}/quests/${quest}/qr/regenerate`, s.cookie);
      expect(response.statusCode).toBe(200);
      const fresh = response.json<{ version: number; url: string }>();
      expect(fresh.version).toBe(2);
      expect(fresh.url).not.toBe(before?.url);
      expect(await currentVersion(quest)).toBe(2);
      // What the completion engine (T-105) does: a valid signature with an old version is refused.
      const old = verifyQuestCode(KEY, tokenOf(before?.url ?? ""), quest);
      expect(old).toMatchObject({ kind: "valid", version: 1 });
      expect(verifyQuestCode(KEY, tokenOf(fresh.url), quest)).toMatchObject({ version: 2 });
      const audits = await owner<{ before: unknown; after: unknown }>(
        "SELECT before, after FROM audit_log WHERE target_id = $1 AND action = 'quest.qr_regenerate'",
        [quest],
      );
      expect(audits).toEqual([{ before: { version: 1 }, after: { version: 2 } }]);
      expect(JSON.stringify(audits)).not.toContain(tokenOf(fresh.url));
    });

    it("needs no second confirmation in a live event, and refuses in an ended one", async () => {
      const s = await newEvent();
      const quest = await addQuest(s);
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 hour', ends_at = now() + interval '1 day' WHERE id = $1",
        [s.eventId],
      );
      expect(
        (await call("POST", `${s.base}/quests/${quest}/qr/regenerate`, s.cookie)).statusCode,
      ).toBe(200);
      await owner(
        "UPDATE event SET status = 'ended', starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1",
        [s.eventId],
      );
      const closed = await call("POST", `${s.base}/quests/${quest}/qr/regenerate`, s.cookie);
      expect(closed.json()).toMatchObject({ code: "event_closed" });
      expect(await currentVersion(quest)).toBe(2);
      // An ended event's codes are still listed: an organizer looks back at what was printed.
      const listed = await call("GET", `${s.base}/codes`, s.cookie);
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ codes: Code[] }>().codes).toHaveLength(1);
    });

    it("answers 404 for a quest without a printed code, or one of another event", async () => {
      const s = await newEvent();
      const other = await newEvent();
      const typed = await addQuest(s, { type: "enter_code", config: { code: "NAJD2030" } });
      const theirs = await addQuest(other);
      for (const quest of [typed, theirs]) {
        const response = await call("POST", `${s.base}/quests/${quest}/qr/regenerate`, s.cookie);
        expect(response.statusCode).toBe(404);
      }
      expect(await currentVersion(theirs)).toBe(1);
    });
  });

  it("never gives a limited editor the codes of an event outside their limit", async () => {
    const s = await newEvent();
    const outside = await addQuest(s);
    const mine = await call("POST", `/v1/organizers/${s.orgId}/events`, s.cookie, EVENT, key());
    const mineId = mine.json<{ event: { id: string } }>().event.id;
    counter += 1;
    const email = `limited${counter}@codes.test`;
    const editor = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [s.orgId, editor, [mineId]],
    );
    const cookie = await signInFully(test, email);
    expect((await call("GET", `${s.base}/codes`, cookie)).statusCode).toBe(404);
    expect(
      (await call("POST", `${s.base}/quests/${outside}/qr/regenerate`, cookie)).statusCode,
    ).toBe(404);
    expect(await currentVersion(outside)).toBe(1);
    const own = await call("GET", `/v1/organizers/${s.orgId}/events/${mineId}/codes`, cookie);
    expect(own.statusCode).toBe(200);
  });

  it("leaves a deleted quest's printed code pointing at nothing (FR-305)", async () => {
    const s = await newEvent();
    const quest = await addQuest(s);
    const [code] = await codes(s);
    await call("DELETE", `${s.base}/quests/${quest}`, s.cookie);
    expect(verifyQuestCode(KEY, tokenOf(code?.url ?? ""), quest)).toMatchObject({ kind: "valid" });
    expect(await currentVersion(quest)).toBeUndefined();
  });
});
