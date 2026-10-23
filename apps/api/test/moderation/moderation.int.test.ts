import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * The event team's view of players over HTTP (T-208): the list for members, bans and the exclusion list for the owner,
 * with phones masked for every seat.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("players, bans and exclusions over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let otherOrganizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const made = async (name: string) =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ($1, $1) RETURNING id",
          [name],
        )
      ).rows[0]?.id ?? "";
    organizer = await made("mod-org");
    otherOrganizer = await made("other-org");
    const ownerId = await createStaff(db.owner, { email: "owner@mod.test" });
    const editorId = await createStaff(db.owner, { email: "editor@mod.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')",
      [organizer, ownerId, editorId],
    );
    ownerCookie = await signInFully(test, "owner@mod.test");
    editorCookie = await signInFully(test, "editor@mod.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (org = organizer): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Mod Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [org, `MOD${counter}`],
    );
    return event?.id ?? "";
  };

  const newPlayer = async (event: string, name?: string): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username, birth_year) VALUES ($1, 1991) RETURNING id",
      [name ?? `mod_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `mod${counter}@x.sa`,
    ]);
    const [enrollment] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT organizer_id, id, $2 FROM event WHERE id = $1 RETURNING id",
      [event, player?.id],
    );
    return enrollment?.id ?? "";
  };

  const call = (
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    cookie = ownerCookie,
    payload?: object,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie),
      ...(payload === undefined ? {} : { payload }),
    });

  describe("the players list", () => {
    it("shows each player's disclosed details only, page by page, to the owner and editors", async () => {
      const event = await newEvent();
      const made = [
        await newPlayer(event, "Noura_M"),
        await newPlayer(event),
        await newPlayer(event),
        await newPlayer(event),
      ];
      for (const cookie of [ownerCookie, editorCookie]) {
        const all = await call("GET", `/events/${event}/players`, cookie);
        expect(all.statusCode).toBe(200);
        expect(all.json<{ players: Row[] }>().players.map((p) => p["enrollmentId"])).toEqual(made);
        expect(Object.keys(all.json<{ players: Row[] }>().players[0] ?? {}).toSorted()).toEqual(
          [
            "answers",
            "avatar",
            "enrollmentId",
            "joinedAt",
            "openFlag",
            "redeemPaused",
            "rehearsal",
            "score",
            "status",
            "username",
          ].toSorted(),
        );
        expect(all.body).not.toContain("1991");
        expect(all.body).not.toContain("@x.sa");
      }
      const first = (await call("GET", `/events/${event}/players?limit=3`)).json<{
        players: Row[];
        nextCursor: string | null;
      }>();
      expect(first.players).toHaveLength(3);
      const rest = (await call("GET", `/events/${event}/players?cursor=${first.nextCursor}`)).json<{
        players: Row[];
        nextCursor: string | null;
      }>();
      expect(rest).toMatchObject({ players: [{ enrollmentId: made[3] }], nextCursor: null });
      expect(
        (await call("GET", `/events/${event}/players?q=%20noura%20`)).json<{ players: Row[] }>()
          .players,
      ).toMatchObject([{ username: "Noura_M" }]);
      for (const query of ["cursor=***", "limit=0", "q=" + "x".repeat(31), "extra=1"]) {
        expect((await call("GET", `/events/${event}/players?${query}`)).statusCode, query).toBe(
          400,
        );
      }
    });

    it("answers 404 for another organizer's event and one outside an editor's events", async () => {
      const foreign = await newEvent(otherOrganizer);
      await newPlayer(foreign);
      expect((await call("GET", `/events/${foreign}/players`)).statusCode).toBe(404);
      const event = await newEvent();
      const limitedEmail = `limited${counter}@mod.test`;
      const limitedId = await createStaff(db.owner, { email: limitedEmail });
      const elsewhere = await newEvent();
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', ARRAY[$3::uuid])",
        [organizer, limitedId, elsewhere],
      );
      const limited = await signInFully(test, limitedEmail);
      expect((await call("GET", `/events/${event}/players`, limited)).statusCode).toBe(404);
      expect((await call("GET", `/events/${event}/exclusions`, limited)).statusCode).toBe(404);
      expect((await call("GET", `/events/${elsewhere}/players`, limited)).statusCode).toBe(200);
    });
  });

  describe("banning", () => {
    it("lets the owner ban and lift, and nobody else", async () => {
      const event = await newEvent();
      const enrollment = await newPlayer(event);
      const path = `/events/${event}/players/${enrollment}/ban`;
      const refused = await call("PUT", path, editorCookie, { banned: true });
      expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        403,
        "owner_only",
      ]);
      const banned = await call("PUT", path, ownerCookie, { banned: true });
      expect([banned.statusCode, banned.json()]).toEqual([200, { banned: true }]);
      expect((await call("PUT", path, ownerCookie, { banned: true })).json()).toEqual({
        banned: true,
      });
      expect(
        (await call("GET", `/events/${event}/players`)).json<{ players: Row[] }>().players,
      ).toMatchObject([{ status: "banned" }]);
      expect((await call("PUT", path, ownerCookie, { banned: false })).json()).toEqual({
        banned: false,
      });
      expect(
        await owner("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id", [enrollment]),
      ).toEqual([{ action: "event.player_ban" }, { action: "event.player_unban" }]);
    });

    it("answers a removed player, another event's player and a malformed request", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const enrollment = await newPlayer(event);
      expect(
        (
          await call("PUT", `/events/${other}/players/${enrollment}/ban`, ownerCookie, {
            banned: true,
          })
        ).statusCode,
      ).toBe(404);
      await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [enrollment]);
      const removed = await call("PUT", `/events/${event}/players/${enrollment}/ban`, ownerCookie, {
        banned: true,
      });
      expect([removed.statusCode, removed.json<{ code: string }>().code]).toEqual([
        409,
        "ban_not_allowed",
      ]);
      for (const payload of [{}, { banned: "yes" }, { banned: true, reason: "x" }]) {
        expect(
          (await call("PUT", `/events/${event}/players/${enrollment}/ban`, ownerCookie, payload))
            .statusCode,
        ).toBe(400);
      }
      expect(
        (
          await call("PUT", `/events/${event}/players/not-a-uuid/ban`, ownerCookie, {
            banned: true,
          })
        ).statusCode,
      ).toBe(400);
    });
  });

  describe("the exclusion list", () => {
    it("takes phones in any common form and domains, masks phones for everyone, and removes by id", async () => {
      const event = await newEvent();
      const phone = await call("POST", `/events/${event}/exclusions`, ownerCookie, {
        kind: "phone",
        value: "٠٥٥ ١٢٣ ٤٥٦٧",
      });
      expect([phone.statusCode, phone.json()]).toEqual([
        201,
        { exclusion: { id: expect.any(String), kind: "phone", value: "•••• 4567" } },
      ]);
      const again = await call("POST", `/events/${event}/exclusions`, ownerCookie, {
        kind: "phone",
        value: "+966551234567",
      });
      expect([again.statusCode, again.json<{ exclusion: Row }>().exclusion["id"]]).toEqual([
        200,
        phone.json<{ exclusion: Row }>().exclusion["id"],
      ]);
      for (const value of ["@Sponsor.SA", " partner.sa ", "nic.xn--mgberp4a5d4ar"]) {
        expect(
          (
            await call("POST", `/events/${event}/exclusions`, ownerCookie, {
              kind: "email_domain",
              value,
            })
          ).statusCode,
        ).toBe(201);
      }
      for (const cookie of [ownerCookie, editorCookie]) {
        const list = await call("GET", `/events/${event}/exclusions`, cookie);
        expect(
          list
            .json<{ exclusions: Row[] }>()
            .exclusions.map((x) => x["value"])
            .toSorted(),
        ).toEqual(["nic.xn--mgberp4a5d4ar", "partner.sa", "sponsor.sa", "•••• 4567"].toSorted());
        expect(list.body).not.toContain("551234567");
      }
      const id = String(phone.json<{ exclusion: Row }>().exclusion["id"]);
      expect(
        (await call("DELETE", `/events/${event}/exclusions/${id}`, editorCookie)).statusCode,
      ).toBe(403);
      expect((await call("DELETE", `/events/${event}/exclusions/${id}`)).statusCode).toBe(204);
      expect((await call("DELETE", `/events/${event}/exclusions/${id}`)).statusCode).toBe(404);
    });

    it("refuses bad values, non-owners and other organizers' events, and says when the list is full", async () => {
      const event = await newEvent();
      for (const [kind, value] of [
        ["phone", "0123"],
        ["phone", "+14155550100"],
        ["email_domain", "a@b.sa"],
        ["email_domain", "nodot"],
        ["email_domain", "-x.sa"],
      ] as const) {
        const refused = await call("POST", `/events/${event}/exclusions`, ownerCookie, {
          kind,
          value,
        });
        expect(
          [refused.statusCode, refused.json<{ code: string; details: Row }>()],
          value,
        ).toMatchObject([422, { code: "invalid_exclusion", details: { kind } }]);
      }
      expect(
        (
          await call("POST", `/events/${event}/exclusions`, ownerCookie, {
            kind: "fax",
            value: "1",
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call("POST", `/events/${event}/exclusions`, editorCookie, {
            kind: "email_domain",
            value: "x.sa",
          })
        ).statusCode,
      ).toBe(403);
      const foreign = await newEvent(otherOrganizer);
      expect(
        (
          await call("POST", `/events/${foreign}/exclusions`, ownerCookie, {
            kind: "email_domain",
            value: "x.sa",
          })
        ).statusCode,
      ).toBe(404);
      expect((await call("GET", `/events/${foreign}/exclusions`)).statusCode).toBe(404);
      const [staff] = await owner<{ id: string }>(
        "SELECT id FROM staff_user WHERE email = 'owner@mod.test'",
      );
      await owner(
        `INSERT INTO event_exclusion (organizer_id, event_id, kind, value, created_by)
         SELECT $1, $2, 'email_domain', 'f' || n || '.sa', $3 FROM generate_series(1, 500) n`,
        [organizer, event, staff?.id],
      );
      const full = await call("POST", `/events/${event}/exclusions`, ownerCookie, {
        kind: "email_domain",
        value: "late.sa",
      });
      expect([full.statusCode, full.json<{ code: string }>().code]).toEqual([
        409,
        "exclusion_list_full",
      ]);
    });
  });
});
