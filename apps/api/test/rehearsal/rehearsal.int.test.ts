import { createHash, randomBytes } from "node:crypto";
import { joinCard } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testCode } from "#src/rehearsal/rehearsal";
import {
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Rehearsal over HTTP (T-211): the team's card, rotate and erase; the player's card and join; the refusals in both
 * languages; the test code a digital reward shows; and the builder's "erase rehearsal first".
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("rehearsal over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let otherOrganizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let strangerCookie: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const org = async (slug: string) =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ($1, $1) RETURNING id",
          [slug],
        )
      ).rows[0]?.id ?? "";
    organizer = await org("reh-co");
    otherOrganizer = await org("reh-other");
    const ownerId = await createStaff(db.owner, { email: "owner@reh.test" });
    const editorId = await createStaff(db.owner, { email: "editor@reh.test" });
    const strangerId = await createStaff(db.owner, { email: "stranger@reh.test" });
    await db.owner.query(
      `INSERT INTO organizer_member (organizer_id, staff_user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'editor'), ($4, $5, 'owner')`,
      [organizer, ownerId, editorId, otherOrganizer, strangerId],
    );
    ownerCookie = await signInFully(test, "owner@reh.test");
    editorCookie = await signInFully(test, "editor@reh.test");
    strangerCookie = await signInFully(test, "stranger@reh.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (status = "draft"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, venue_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Spring Fest', 'Riyadh Front', $3, now() + interval '1 day', now() + interval '2 days')
       RETURNING id`,
      [organizer, `REHH${counter}`, status],
    );
    return event?.id ?? "";
  };

  const staff = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    cookie = ownerCookie,
    org = organizer,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${org}${url}`,
      headers: withSession(cookie, {}),
    });

  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`reh_http_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [made?.id, createHash("sha256").update(token).digest()],
    );
    return token;
  };
  const asPlayer = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": freshIp() },
      ...(payload === undefined ? {} : { payload }),
    });
  const joinWith = (token: string, code: string, cardVersion = joinCard().version) =>
    asPlayer(token, "POST", "/v1/rehearsals/join", { code, cardVersion });

  const codeOf = async (event: string): Promise<string> =>
    (await staff("GET", `/events/${event}/rehearsal`)).json<{ rehearsal: { code: string } }>()
      .rehearsal.code;

  describe("the team's card", () => {
    it("opens with a code on first read, the same for the editor, with nothing in it yet", async () => {
      const event = await newEvent();
      const first = await staff("GET", `/events/${event}/rehearsal`);
      expect(first.statusCode).toBe(200);
      const card = first.json<{ rehearsal: { code: string } }>().rehearsal;
      expect(card).toMatchObject({
        open: true,
        cap: 25,
        now: { accounts: 0, completions: 0, points: 0, reservations: 0, flags: 0 },
        erased: null,
      });
      expect(card.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(await codeOf(event)).toBe(card.code);
      const editor = await staff("GET", `/events/${event}/rehearsal`, editorCookie);
      expect(editor.json()).toMatchObject({ rehearsal: { code: card.code } });
    });

    it("rotates the code, and keeps another organizer out", async () => {
      const event = await newEvent();
      const before = await codeOf(event);
      const rotated = await staff("POST", `/events/${event}/rehearsal/code`, editorCookie);
      expect(rotated.statusCode).toBe(200);
      const code = rotated.json<{ code: string }>().code;
      expect(code).not.toBe(before);
      expect(await codeOf(event)).toBe(code);
      for (const path of ["", "/code", "/erase"]) {
        const method = path === "" ? "GET" : "POST";
        const outsider = await staff(
          method,
          `/events/${event}/rehearsal${path}`,
          strangerCookie,
          otherOrganizer,
        );
        expect(outsider.statusCode).toBe(404);
      }
    });

    it("erases, and refuses once the event has gone live", async () => {
      const event = await newEvent("scheduled");
      const code = await codeOf(event);
      expect((await joinWith(await newPlayer(), code)).statusCode).toBe(200);
      const erased = await staff("POST", `/events/${event}/rehearsal/erase`);
      expect(erased.statusCode).toBe(200);
      expect(erased.json()).toMatchObject({ erased: { accounts: 1 } });
      await owner("UPDATE event SET status = 'live' WHERE id = $1", [event]);
      const late = await staff("POST", `/events/${event}/rehearsal/erase`);
      expect(late.statusCode).toBe(409);
      expect(late.json()).toMatchObject({ code: "rehearsal_over" });
      const card = await staff("GET", `/events/${event}/rehearsal`);
      expect(card.json()).toMatchObject({ rehearsal: { code: null, open: false } });
    });
  });

  describe("the player's side", () => {
    it("reads the event by its code, joins, and opens it as a rehearsal account", async () => {
      const event = await newEvent();
      const code = await codeOf(event);
      const token = await newPlayer();
      const read = await asPlayer(token, "GET", `/v1/rehearsals/${code.toLowerCase()}`);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        event: { id: event, name: { en: "Spring Fest" }, statusNow: "draft" },
        card: { version: joinCard().version },
      });
      const joined = await joinWith(token, code);
      expect(joined.json()).toMatchObject({ eventId: event, alreadyMember: false });
      expect((await joinWith(token, code)).json()).toMatchObject({ alreadyMember: true });
      const mine = await asPlayer(token, "GET", "/v1/me/events");
      expect(mine.json()).toMatchObject({
        events: [{ id: event, statusNow: "draft", rehearsal: true }],
      });
      const home = await asPlayer(token, "GET", `/v1/events/${event}/home`);
      expect(home.json()).toMatchObject({ event: { statusNow: "draft", rehearsal: true } });
      const players = await staff("GET", `/events/${event}/players`);
      expect(players.json()).toMatchObject({ players: [{ rehearsal: true }] });
    });

    it("answers each refusal in both languages", async () => {
      const event = await newEvent("scheduled");
      const code = await codeOf(event);
      const unknown = await joinWith(await newPlayer(), "ZZZZ-ZZZZ");
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({
        code: "rehearsal_closed",
        message: { ar: expect.any(String) },
      });
      expect((await asPlayer(await newPlayer(), "GET", "/v1/rehearsals/NOTACODE")).statusCode).toBe(
        404,
      );
      expect((await joinWith(await newPlayer(), code, "0.0.1")).json()).toMatchObject({
        code: "card_version_stale",
      });
      const member = await newPlayer();
      const [row] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      expect(
        (
          await asPlayer(member, "POST", "/v1/join", {
            joinCode: row?.join_code,
            via: "code",
            cardVersion: joinCard().version,
          })
        ).statusCode,
      ).toBe(200);
      expect((await joinWith(member, code)).json()).toMatchObject({ code: "already_player" });
      const rehearsing = await newPlayer();
      await joinWith(rehearsing, code);
      const real = await asPlayer(rehearsing, "POST", "/v1/join", {
        joinCode: row?.join_code,
        via: "code",
        cardVersion: joinCard().version,
      });
      expect(real.statusCode).toBe(409);
      expect(real.json()).toMatchObject({ code: "rehearsing" });
    });

    it("says full at the cap", async () => {
      const event = await newEvent();
      const code = await codeOf(event);
      await owner(
        `WITH made AS (
           INSERT INTO player (username) SELECT 'cap_' || g || '_' || $3 FROM generate_series(1, 25) AS g RETURNING id
         )
         INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, card_version)
         SELECT $1, $2, made.id, 'rehearsal', '1' FROM made`,
        [organizer, event, counter],
      );
      const full = await joinWith(await newPlayer(), code);
      expect(full.statusCode).toBe(409);
      expect(full.json()).toMatchObject({ code: "rehearsal_full" });
    });

    it("shows a digital reward's test code, the same on every read", async () => {
      const event = await newEvent();
      const code = await codeOf(event);
      const token = await newPlayer();
      const joined = (await joinWith(token, code)).json<{ enrollmentId: string }>();
      const [reward] = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'digital', 'Voucher', 5, 0) RETURNING id",
        [event],
      );
      await owner(
        `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
         VALUES ($1, $2, $3, decode(repeat('00', 29), 'hex'), decode(md5('x') || md5('y'), 'hex'))`,
        [organizer, event, reward?.id],
      );
      await owner("UPDATE reward SET stock_total = 1 WHERE id = $1", [reward?.id]);
      await owner(
        "INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor, staff_user_id) VALUES ($1, $2, $3, 'award', 50, 50, 'staff', $4)",
        [organizer, event, joined.enrollmentId, organizer],
      );
      const reserved = await test.app.inject({
        method: "POST",
        url: `/v1/rewards/${reward?.id}/reserve`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": "6f1d1c2e-3c55-4a0e-9a8d-1b2c3d4e5f60",
        },
      });
      expect(reserved.statusCode).toBe(201);
      const redemption = reserved.json<{
        redemption: { id: string; code: string; testCode: boolean };
      }>().redemption;
      expect(redemption).toMatchObject({ code: testCode(redemption.id), testCode: true });
      const shop = await asPlayer(token, "GET", `/v1/events/${event}/shop`);
      expect(shop.json()).toMatchObject({
        redemptions: [{ id: redemption.id, code: testCode(redemption.id), testCode: true }],
      });
    });
  });

  describe("the builder", () => {
    it("asks to erase rehearsal first before deleting a quest or a draft it holds", async () => {
      const event = await newEvent();
      const code = await codeOf(event);
      const token = await newPlayer();
      await joinWith(token, code);
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, 'enter_code', 'Lion', 10, 1, true, '{"code": "LION"}' FROM category WHERE event_id = $1
         LIMIT 1 RETURNING id`,
        [event],
      );
      const scanned = await test.app.inject({
        method: "POST",
        url: `/v1/quests/${quest?.id}/complete`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": "1f1d1c2e-3c55-4a0e-9a8d-1b2c3d4e5f60",
        },
        payload: { proof: { type: "code", code: "LION" } },
      });
      expect(scanned.statusCode).toBe(200);
      const remove = await staff("DELETE", `/events/${event}/quests/${quest?.id}`);
      expect(remove.statusCode).toBe(409);
      expect(remove.json()).toMatchObject({ code: "rehearsal_data" });
      const draft = await staff("DELETE", `/events/${event}`);
      expect(draft.statusCode).toBe(409);
      expect(draft.json()).toMatchObject({ code: "rehearsal_data" });
      await staff("POST", `/events/${event}/rehearsal/erase`);
      expect((await staff("DELETE", `/events/${event}/quests/${quest?.id}`)).statusCode).toBe(204);
    });
  });
});
