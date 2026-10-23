import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createQuestCodeKey,
  createRevealCodeKey,
  createStepCodeKey,
  verifyQuestCode,
  verifyRevealCode,
  verifyStepCode,
} from "#src/quests/qr";
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
type Secret = { categoryId: string; category: Code["title"]; version: number; url: string };

const KEY = createQuestCodeKey(testConfig().qrSecret);
const STEP_KEY = createStepCodeKey(testConfig().qrSecret);
const REVEAL_KEY = createRevealCodeKey(testConfig().qrSecret);
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
  const addHiddenCategory = async (s: Setup, name: string): Promise<string> => {
    const made = await call(
      "POST",
      `${s.base}/categories`,
      s.cookie,
      { name: { en: name } },
      key(),
    );
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ category: { id: string } }>().category.id;
    const patched = await call(
      "PATCH",
      `${s.base}/categories/${id}`,
      s.cookie,
      { hidden: true },
      key(),
    );
    expect(patched.statusCode, patched.body).toBe(200);
    return id;
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
        stepId: null,
        step: null,
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

    it("signs a passport step's code for the step, and a hidden category's secret for the category", async () => {
      const s = await newEvent();
      const passport = await addQuest(s, {
        type: "passport",
        title: { en: "Booths" },
        config: { needed: 1 },
        steps: [{ name: { en: "Booth A" } }],
      });
      const [step] = await owner<{ id: string }>(
        "SELECT id FROM passport_step WHERE quest_id = $1",
        [passport],
      );
      const hidden = await addHiddenCategory(s, "Vault");
      const listed = await call("GET", `${s.base}/codes`, s.cookie);
      const { codes: list, secrets } = listed.json<{ codes: Code[]; secrets: Secret[] }>();
      expect(list).toHaveLength(1);
      expect(verifyStepCode(STEP_KEY, tokenOf(list[0]?.url ?? ""), step?.id ?? "")).toEqual({
        kind: "valid",
        stepId: step?.id,
        version: 1,
      });
      expect(secrets).toEqual([
        {
          categoryId: hidden,
          category: { ar: null, en: "Vault" },
          version: 1,
          url: expect.any(String),
        },
      ]);
      expect(verifyRevealCode(REVEAL_KEY, tokenOf(secrets[0]?.url ?? ""), hidden)).toEqual({
        kind: "valid",
        categoryId: hidden,
        version: 1,
      });
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

    it("audits a step's and a secret's regeneration with their versions, never a code", async () => {
      const s = await newEvent();
      const passport = await addQuest(s, {
        type: "passport",
        title: { en: "Booths" },
        config: { needed: 1 },
        steps: [{ name: { en: "Booth A" } }],
      });
      const [step] = await owner<{ id: string }>(
        "SELECT id FROM passport_step WHERE quest_id = $1",
        [passport],
      );
      const stepId = step?.id ?? "";
      const hidden = await addHiddenCategory(s, "Vault");
      for (const path of [`steps/${stepId}/qr`, `categories/${hidden}/reveal`]) {
        const response = await call("POST", `${s.base}/${path}/regenerate`, s.cookie);
        expect(response.json(), path).toMatchObject({ version: 2 });
      }
      const audits = await owner<{ action: string; before: unknown; after: unknown }>(
        `SELECT action, before, after FROM audit_log
         WHERE target_id = ANY ($1) AND action IN ('quest.step_qr_regenerate', 'category.reveal_regenerate')
         ORDER BY action`,
        [[passport, hidden]],
      );
      expect(audits).toEqual([
        { action: "category.reveal_regenerate", before: { version: 1 }, after: { version: 2 } },
        {
          action: "quest.step_qr_regenerate",
          before: { stepId, version: 1 },
          after: { stepId, version: 2 },
        },
      ]);
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
