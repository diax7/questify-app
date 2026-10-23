import { createHash, randomBytes, randomUUID } from "node:crypto";
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

type Row = Record<string, unknown>;

/**
 * The flagged-activity page over HTTP (T-209): the list, a case, clearing and closing it, the owner's pause and hold
 * switch, who may do which, and the desk's find never writing what was searched to the log.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("flags over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let lines: string[] = [];
  let organizer = "";
  let ownerCookie = "";
  let editorCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "debug",
      stream: { write: (line: string) => void lines.push(line) },
    });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('flag-org', 'flag-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    for (const [email, role] of [
      ["owner@flag.test", "owner"],
      ["editor@flag.test", "editor"],
    ] as const) {
      const id = await createStaff(db.owner, { email });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
        [organizer, id, role],
      );
    }
    ownerCookie = await signInFully(test, "owner@flag.test");
    editorCookie = await signInFully(test, "editor@flag.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en)
       VALUES ($1, $2, 'Flag Fest', 'live', now() - interval '1 hour', now() + interval '1 day', 'Hall B')
       RETURNING id`,
      [organizer, `FLAGH${counter}`],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event?.id]);
    return event?.id ?? "";
  };

  /** A member with an open burst case: ten completions in the window, straight into the table. */
  const flagged = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`flag_h_${counter}`],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, player?.id],
    );
    for (let i = 0; i < 10; i += 1) {
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points)
         SELECT $1, id, 'scan_qr', 'Lion', 10 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event],
      );
      const [done] = await owner<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
        [organizer, event, enrolled?.id, quest?.id, randomUUID()],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor)
         VALUES ($1, $2, $3, 'quest', 10, 10, $4, $5, 'player')`,
        [organizer, event, enrolled?.id, done?.id, quest?.id],
      );
    }
    const [flag] = await owner<{ id: string }>("SELECT id FROM flag WHERE enrollment_id = $1", [
      enrolled?.id,
    ]);
    return { player: player?.id ?? "", enrollment: enrolled?.id ?? "", flag: flag?.id ?? "" };
  };

  const dashboard = (
    cookie: string,
    method: "GET" | "PUT" | "POST",
    path: string,
    payload?: object,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });

  it("lists open cases with the hold, shows one, and closes it once", async () => {
    const event = await newEvent();
    const { flag, enrollment } = await flagged(event);
    const listed = await dashboard(editorCookie, "GET", `/events/${event}/flags`);
    expect(listed.json()).toMatchObject({
      hold: true,
      flags: [
        {
          id: flag,
          kind: "burst",
          status: "open",
          scans: 10,
          player: { enrollmentId: enrollment },
        },
      ],
      nextCursor: null,
    });
    const shown = await dashboard(editorCookie, "GET", `/events/${event}/flags/${flag}`);
    expect(shown.json()).toMatchObject({ flag: { id: flag, paused: false, removals: [] } });
    expect(shown.json<{ flag: { evidence: unknown[] } }>().flag.evidence).toHaveLength(10);

    const noRemoval = await dashboard(
      editorCookie,
      "POST",
      `/events/${event}/flags/${flag}/resolve`,
      {
        resolution: "points_removed",
      },
    );
    expect(noRemoval.statusCode).toBe(409);
    expect(noRemoval.json()).toMatchObject({ code: "no_removal" });
    const cleared = await dashboard(
      editorCookie,
      "POST",
      `/events/${event}/flags/${flag}/resolve`,
      {
        resolution: "cleared",
        note: "a quick runner",
      },
    );
    expect(cleared.json()).toEqual({ status: "cleared", resolution: "cleared" });
    const again = await dashboard(ownerCookie, "POST", `/events/${event}/flags/${flag}/resolve`, {
      resolution: "cleared",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "resolved" });
    expect((await dashboard(ownerCookie, "GET", `/events/${event}/flags`)).json()).toMatchObject({
      flags: [],
    });
    expect(
      (await dashboard(ownerCookie, "GET", `/events/${event}/flags?status=closed`)).json(),
    ).toMatchObject({ flags: [{ id: flag, resolution: "cleared" }] });
  });

  it("answers 404 for an unknown case or event and 400 for a bad request", async () => {
    const event = await newEvent();
    expect(
      (await dashboard(ownerCookie, "GET", `/events/${event}/flags/999999999`)).statusCode,
    ).toBe(404);
    expect((await dashboard(ownerCookie, "GET", `/events/${randomUUID()}/flags`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await dashboard(ownerCookie, "POST", `/events/${event}/flags/999999999/resolve`, {
          resolution: "cleared",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await dashboard(ownerCookie, "POST", `/events/${event}/flags/1/resolve`, {
          resolution: "banned",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await dashboard(ownerCookie, "GET", `/events/${event}/flags?cursor=nonsense`)).statusCode,
    ).toBe(400);
    const { flag } = await flagged(event);
    const long = await dashboard(ownerCookie, "POST", `/events/${event}/flags/${flag}/resolve`, {
      resolution: "cleared",
      note: "x".repeat(301),
    });
    expect(long.statusCode).toBe(400);
  });

  it("pages the list newest first", async () => {
    const event = await newEvent();
    const first = await flagged(event);
    const second = await flagged(event);
    const page = await dashboard(ownerCookie, "GET", `/events/${event}/flags?limit=1`);
    const body = page.json<{ flags: { id: string }[]; nextCursor: string }>();
    expect(body.flags.map((f) => f.id)).toEqual([second.flag]);
    const next = await dashboard(
      ownerCookie,
      "GET",
      `/events/${event}/flags?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`,
    );
    expect(next.json<{ flags: { id: string }[] }>().flags.map((f) => f.id)).toEqual([first.flag]);
  });

  it("lets only the owner pause a player and switch the hold, and shows both", async () => {
    const event = await newEvent();
    const { enrollment, flag } = await flagged(event);
    const byEditor = await dashboard(
      editorCookie,
      "PUT",
      `/events/${event}/players/${enrollment}/redeem-pause`,
      {
        paused: true,
      },
    );
    expect(byEditor.statusCode).toBe(403);
    const paused = await dashboard(
      ownerCookie,
      "PUT",
      `/events/${event}/players/${enrollment}/redeem-pause`,
      {
        paused: true,
      },
    );
    expect(paused.json()).toEqual({ paused: true });
    expect(
      (
        await dashboard(
          ownerCookie,
          "PUT",
          `/events/${event}/players/${randomUUID()}/redeem-pause`,
          {
            paused: true,
          },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await dashboard(editorCookie, "PUT", `/events/${event}/flag-hold`, { on: false }))
        .statusCode,
    ).toBe(403);
    expect(
      (await dashboard(ownerCookie, "PUT", `/events/${event}/flag-hold`, { on: false })).json(),
    ).toEqual({
      on: false,
    });
    expect((await dashboard(ownerCookie, "GET", `/events/${event}/flags`)).json()).toMatchObject({
      hold: false,
    });
    expect(
      (await dashboard(ownerCookie, "GET", `/events/${event}/flags/${flag}`)).json(),
    ).toMatchObject({
      flag: { paused: true, hold: false },
    });
    const players = await dashboard(editorCookie, "GET", `/events/${event}/players`);
    expect(players.json()).toMatchObject({
      players: [{ enrollmentId: enrollment, openFlag: flag, redeemPaused: true }],
    });
  });

  it("never writes the desk's search to the log", async () => {
    const event = await newEvent();
    counter += 1;
    const [person] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`flag_desk_${counter}`],
    );
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{hand_over}')",
      [organizer, event, person?.id],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [person?.id, createHash("sha256").update(token).digest()],
    );
    lines = [];
    const found = await test.app.inject({
      method: "POST",
      url: `/v1/operator/events/${event}/desk/find`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "0551234567" },
    });
    expect(found.json()).toEqual({ result: "none" });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/551234567/);
  });
});
