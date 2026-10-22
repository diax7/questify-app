import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import {
  createStaff,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Reward = { id: string; kind: string; stock: number; stockLeft: number; lowCodes: boolean };

const key = () => ({ "idempotency-key": randomUUID() });
const eventOf = (base: string) => base.split("/").at(-1) ?? "";

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "spending lowers rank and digital codes over HTTP (T-219, T-203)",
  () => {
    let db: TestDatabase;
    let test: TestApp;
    let counter = 0;
    let orgId = "";
    let ownerId = "";
    let ownerCookie = "";
    let editorCookie = "";
    const lines: string[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
      test = await startApp(db, {
        ...loggerOptions(testConfig()),
        level: "debug",
        stream: { write: (line: string) => void lines.push(line) },
      });
      const [org] = await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Najd Codes', 'codes') RETURNING id",
      );
      orgId = org?.id ?? "";
      ownerId = await createStaff(db.owner, { email: "owner@codes.test" });
      const editor = await createStaff(db.owner, { email: "editor@codes.test" });
      for (const [staff, role] of [
        [ownerId, "owner"],
        [editor, "editor"],
      ] as const) {
        await owner(
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
          [orgId, staff, role],
        );
      }
      ownerCookie = await signInFully(test, "owner@codes.test");
      editorCookie = await signInFully(test, "editor@codes.test");
    });
    afterAll(async () => {
      await test.close();
      await db.close();
    });

    async function owner<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
      return (await db.owner.query<T>(sql, values)).rows;
    }

    const call = (
      cookie: string,
      method: "GET" | "POST" | "PATCH" | "PUT",
      url: string,
      payload?: object,
      headers: Record<string, string> = {},
    ): Promise<LightMyRequestResponse> =>
      test.app.inject({
        method,
        url,
        headers: withSession(cookie, headers),
        ...(payload === undefined ? {} : { payload }),
      });

    const newEvent = async (when: "live" | "scheduled" = "live"): Promise<string> => {
      counter += 1;
      const times =
        when === "live"
          ? "now() - interval '1 hour', now() + interval '1 day'"
          : "now() + interval '1 day', now() + interval '2 days'";
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Codes', '${when}', ${times}) RETURNING id`,
        [orgId, `CODES${counter}`],
      );
      return `/v1/organizers/${orgId}/events/${event?.id}`;
    };

    const newPlayer = async (event: string, points = 1000): Promise<string> => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`coder_${counter}`],
      );
      const token = randomBytes(32).toString("base64url");
      await owner(
        "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [player?.id, createHash("sha256").update(token).digest()],
      );
      const [enrolled] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [orgId, event, player?.id],
      );
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        event,
      ]);
      const [quest] = await owner<{ id: string }>(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Q', $3) RETURNING id",
        [event, general?.id, points],
      );
      const [done] = await owner<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
        [orgId, event, enrolled?.id, quest?.id, randomUUID()],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor)
         VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
        [orgId, event, enrolled?.id, points, done?.id, quest?.id],
      );
      return token;
    };

    const asPlayer = (token: string, method: "GET" | "POST", url: string) =>
      test.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, ...key() },
      });

    const newDigital = async (base: string): Promise<Reward> => {
      const made = await call(
        ownerCookie,
        "POST",
        `${base}/rewards`,
        { kind: "digital", name: { en: "Gift card" }, price: 50 },
        key(),
      );
      expect(made.statusCode).toBe(201);
      return made.json<{ reward: Reward }>().reward;
    };

    describe("spending lowers rank (FR-1847)", () => {
      it("lets the owner switch it before the event, refuses an editor, and audits the change", async () => {
        const base = await newEvent("scheduled");
        const editor = await call(editorCookie, "PUT", `${base}/shop`, { spendLowersRank: true });
        expect(editor.statusCode).toBe(403);
        expect(editor.json()).toMatchObject({ code: "owner_only" });
        const editorSame = await call(editorCookie, "PUT", `${base}/shop`, {
          spendLowersRank: false,
          daysAfter: 5,
        });
        expect(editorSame.statusCode).toBe(200);
        const set = await call(ownerCookie, "PUT", `${base}/shop`, { spendLowersRank: true });
        expect(set.json()).toMatchObject({ shop: { spendLowersRank: true, daysAfter: 5 } });
        const audited = await owner<{ actor_id: string; after: Record<string, unknown> }>(
          `SELECT actor_id, after FROM audit_log WHERE target_id = $1 AND action = 'event.shop.update'
           ORDER BY id DESC LIMIT 1`,
          [eventOf(base)],
        );
        expect(audited[0]).toMatchObject({ actor_id: ownerId, after: { spendLowersRank: true } });
      });

      it("lets the owner switch it on a draft and back", async () => {
        const [draft] = await owner<{ id: string }>(
          "INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'DRAFT1', 'Draft', 'draft') RETURNING id",
          [orgId],
        );
        const base = `/v1/organizers/${orgId}/events/${draft?.id}`;
        for (const value of [true, false]) {
          const saved = await call(ownerCookie, "PUT", `${base}/shop`, { spendLowersRank: value });
          expect(saved.json()).toMatchObject({ shop: { spendLowersRank: value } });
        }
      });

      it("locks it once the event is live, while the other settings still save", async () => {
        const base = await newEvent("live");
        const locked = await call(ownerCookie, "PUT", `${base}/shop`, { spendLowersRank: true });
        expect(locked.statusCode).toBe(409);
        expect(locked.json()).toMatchObject({ code: "setting_locked" });
        expect(
          (
            await call(ownerCookie, "PUT", `${base}/shop`, {
              spendLowersRank: false,
              pickupMinutes: 30,
            })
          ).statusCode,
        ).toBe(200);
      });

      it("tells the player in the shop when a purchase lowers their ranking points", async () => {
        const base = await newEvent("live");
        await owner("UPDATE event SET spend_lowers_rank = true WHERE id = $1", [eventOf(base)]);
        const token = await newPlayer(eventOf(base));
        const shop = await asPlayer(token, "GET", `/v1/events/${eventOf(base)}/shop`);
        expect(shop.json()).toMatchObject({ shop: { spendLowersRank: true } });
      });
    });

    describe("digital codes (FR-510, FR-511, FR-512)", () => {
      it("creates a digital reward at zero stock, warns at once, and refuses a stock for it", async () => {
        const base = await newEvent();
        const reward = await newDigital(base);
        expect(reward).toMatchObject({ kind: "digital", stock: 0, lowCodes: true });
        const withStock = await call(
          ownerCookie,
          "POST",
          `${base}/rewards`,
          { kind: "digital", name: { en: "Card" }, price: 5, stock: 10 },
          key(),
        );
        expect(withStock.json()).toMatchObject({ code: "stock_from_codes" });
        const patched = await call(ownerCookie, "PATCH", `${base}/rewards/${reward.id}`, {
          stock: 4,
        });
        expect(patched.statusCode).toBe(409);
        const item = await call(
          ownerCookie,
          "POST",
          `${base}/rewards`,
          { kind: "item", name: { en: "Mug" }, price: 5 },
          key(),
        );
        expect(item.json()).toMatchObject({ code: "invalid_reward", details: { field: "stock" } });
      });

      it("uploads codes, counts repeats, replays the first answer, and audits counts only", async () => {
        const base = await newEvent();
        const reward = await newDigital(base);
        const url = `${base}/rewards/${reward.id}/codes`;
        const upload = key();
        const codes = Array.from({ length: 60 }, (_, i) => `SECRET-${i}`);
        const first = await call(
          editorCookie,
          "POST",
          url,
          { codes: [...codes, " SECRET-0 "] },
          upload,
        );
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ added: 60, duplicates: 1, stock: 60, stockLeft: 60 });
        const replay = await call(
          editorCookie,
          "POST",
          url,
          { codes: [...codes, " SECRET-0 "] },
          upload,
        );
        expect(replay.json()).toEqual(first.json());
        const again = await call(
          editorCookie,
          "POST",
          url,
          { codes: ["SECRET-1", "NEW-1"] },
          key(),
        );
        expect(again.json()).toEqual({ added: 1, duplicates: 1, stock: 61, stockLeft: 61 });
        const listed = await call(ownerCookie, "GET", `${base}/rewards`);
        expect(listed.json<{ rewards: Reward[] }>().rewards[0]).toMatchObject({
          stock: 61,
          lowCodes: false,
        });
        const audits = await owner<{ after: unknown }>(
          "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'reward.codes.add' ORDER BY id",
          [reward.id],
        );
        expect(audits.map((row) => row.after)).toEqual([
          { added: 60, duplicates: 1, stock: 60 },
          { added: 1, duplicates: 1, stock: 61 },
        ]);
        expect(JSON.stringify(await owner("SELECT * FROM audit_log"))).not.toContain("SECRET-");
      });

      it("takes a stock of 0 for a digital reward, and edits that leave its stock alone", async () => {
        const base = await newEvent();
        const made = await call(
          ownerCookie,
          "POST",
          `${base}/rewards`,
          { kind: "digital", name: { en: "Card" }, price: 5, stock: 0 },
          key(),
        );
        expect(made.statusCode).toBe(201);
        const id = made.json<{ reward: Reward }>().reward.id;
        for (const patch of [{ stock: 0 }, { price: 9 }]) {
          expect(
            (await call(ownerCookie, "PATCH", `${base}/rewards/${id}`, patch)).statusCode,
          ).toBe(200);
        }
      });

      it("refuses an upload past 100 000 codes and keeps nothing of it", async () => {
        const base = await newEvent();
        const reward = await newDigital(base);
        await owner("UPDATE reward SET stock_total = 99999 WHERE id = $1", [reward.id]);
        const refused = await call(
          ownerCookie,
          "POST",
          `${base}/rewards/${reward.id}/codes`,
          { codes: ["ONE", "TWO"] },
          key(),
        );
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({ code: "too_many_codes", details: { room: 1 } });
        expect(await owner("SELECT 1 FROM reward_code WHERE reward_id = $1", [reward.id])).toEqual(
          [],
        );
        expect(
          await owner(
            "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'reward.codes.add'",
            [reward.id],
          ),
        ).toEqual([]);
        const fits = await call(
          ownerCookie,
          "POST",
          `${base}/rewards/${reward.id}/codes`,
          { codes: ["ONE"] },
          key(),
        );
        expect(fits.json()).toMatchObject({ added: 1, stock: 100000 });
      });

      it("refuses bad uploads", async () => {
        const base = await newEvent();
        const reward = await newDigital(base);
        const url = `${base}/rewards/${reward.id}/codes`;
        const refused = async (payload: object) =>
          (await call(ownerCookie, "POST", url, payload, key())).statusCode;
        expect(await refused({ codes: [] })).toBe(400);
        expect(await refused({ codes: ["  "] })).toBe(422);
        expect(await refused({ codes: ["A\u0000B"] })).toBe(422);
        expect(await refused({ codes: Array.from({ length: 5001 }, (_, i) => `C${i}`) })).toBe(400);
        const item = await call(
          ownerCookie,
          "POST",
          `${base}/rewards`,
          { kind: "item", name: { en: "Mug" }, price: 5, stock: 1 },
          key(),
        );
        const itemId = item.json<{ reward: Reward }>().reward.id;
        const notDigital = await call(
          ownerCookie,
          "POST",
          `${base}/rewards/${itemId}/codes`,
          { codes: ["X"] },
          key(),
        );
        expect(notDigital.json()).toMatchObject({ code: "not_digital" });
        const other = await newEvent();
        expect(
          (
            await call(
              ownerCookie,
              "POST",
              `${other}/rewards/${reward.id}/codes`,
              { codes: ["X"] },
              key(),
            )
          ).statusCode,
        ).toBe(404);
      });

      it("takes a full upload of 5 000 long codes", async () => {
        const base = await newEvent();
        const reward = await newDigital(base);
        const codes = Array.from({ length: 5000 }, (_, i) => `${i}-`.padEnd(200, "x"));
        const result = await call(
          ownerCookie,
          "POST",
          `${base}/rewards/${reward.id}/codes`,
          { codes },
          key(),
        );
        expect(result.statusCode).toBe(200);
        expect(result.json()).toMatchObject({ added: 5000 });
      });

      it("shows the player their code at once and in history, never in a log", async () => {
        const base = await newEvent();
        const event = eventOf(base);
        const reward = await newDigital(base);
        await call(
          ownerCookie,
          "POST",
          `${base}/rewards/${reward.id}/codes`,
          { codes: ["VOUCHER-ONLY-ONCE"] },
          key(),
        );
        const token = await newPlayer(event);
        lines.length = 0;
        const reserved = await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`);
        expect(reserved.statusCode).toBe(201);
        expect(reserved.json()).toMatchObject({
          redemption: {
            kind: "digital",
            status: "delivered",
            reservedUntil: null,
            code: "VOUCHER-ONLY-ONCE",
          },
          stockLeft: 0,
        });
        const shop = await asPlayer(token, "GET", `/v1/events/${event}/shop`);
        expect(shop.json()).toMatchObject({
          redemptions: [{ status: "delivered", code: "VOUCHER-ONLY-ONCE" }],
          rewards: [{ stockLeft: 0 }],
        });
        const cancel = await asPlayer(
          token,
          "POST",
          `/v1/redemptions/${reserved.json<{ redemption: { id: string } }>().redemption.id}/cancel`,
        );
        expect(cancel.json()).toMatchObject({
          code: "reservation_ended",
          details: { status: "delivered" },
        });
        const second = await newPlayer(event);
        expect(
          (await asPlayer(second, "POST", `/v1/rewards/${reward.id}/reserve`)).json(),
        ).toMatchObject({ code: "sold_out" });
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join("\n")).not.toContain("VOUCHER-ONLY-ONCE");
        const stored = await owner<{ code_cipher: Buffer }>(
          "SELECT code_cipher FROM reward_code WHERE reward_id = $1",
          [reward.id],
        );
        expect(stored[0]?.code_cipher.toString("latin1")).not.toContain("VOUCHER");
      });
    });
  },
);
