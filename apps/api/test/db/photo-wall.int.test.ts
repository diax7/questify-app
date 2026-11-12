import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Slot = { id: string; key: string };
type Photo = { player: string; enrollment: string; submission: string; media: string; key: string };
type Wall = { shut: string | null; photos?: { mediaId: string; key: string }[] };

const GUIDELINES = "1.0";
const hash = (): Buffer => randomBytes(32);

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

/**
 * The photo wall (T-504b, migration 0195; plan docs/plans/2026-11-12-organizer-images.md sections 4 and 7): a player's
 * per-photo consent, the team's pick tied to its event, the one rule every reader applies at every read
 * (`photo_wall_ok`), the screen's and the app's reads, and the report and hold path that takes a photo off.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the photo wall (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let adminId = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
    const [made] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('wall-mod@questify.test', 'h', 'admin') RETURNING id",
      )
    ).rows;
    adminId = made?.id ?? "";
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });
  const admin = (): RequestContext => ({ isAdmin: true, staffUserId: adminId });

  /** A live event with the big-screen add-on and the photo scene picked (unless `scenes` says otherwise). */
  const newEvent = async (
    options: { org?: string; scenes?: string[]; addon?: boolean } = {},
  ): Promise<string> => {
    counter += 1;
    const org = options.org ?? ids.orgA;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Wall Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [org, `WALL${counter}`],
    );
    const id = event?.id ?? "";
    if (options.addon !== false) {
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [id, org],
      );
      await query(org === ids.orgA ? teamA() : teamB(), "SELECT set_big_screen($1, $2, $3)", [
        id,
        options.scenes ?? ["ranking", "photo"],
        randomUUID(),
      ]);
    }
    return id;
  };
  const newQuest = async (event: string, accepts: string[] = ["photo"]): Promise<string> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_ar, title_en, points, type_config)
       VALUES ($1, $2, 'submission', 'صورة الفريق', 'Team photo', 100, $3) RETURNING id`,
      [event, category?.id, JSON.stringify({ accepts, autoApprove: false, resubmit: true })],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, org = ids.orgA) => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`wall_player_${counter}`],
    );
    const player = made?.id ?? "";
    await owner(
      `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'community_guidelines', $2, 'submission')`,
      [player, GUIDELINES],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [org, event, player],
    );
    return { player, enrollment: enrolled?.id ?? "" };
  };
  const upload = async (player: string, quest: string): Promise<Slot> => {
    const [slot] = await query<Slot>(
      { playerId: player },
      "SELECT * FROM media_reserve('submission', NULL, $1, $2)",
      [quest, randomUUID()],
    );
    await query({ playerId: player }, "SELECT media_stored($1, $2, 1000, 640, 480)", [
      slot?.id,
      slot?.key,
    ]);
    return slot as Slot;
  };
  /** Sends through the six-argument door (or the five-argument one an older API calls, `onScreen` undefined). */
  const send = async (player: string, quest: string, photo: string | null, onScreen?: boolean) => {
    const sql =
      onScreen === undefined
        ? "SELECT * FROM submit_quest($1, $2, $3, $4, $5)"
        : "SELECT * FROM submit_quest($1, $2, $3, $4, $5, $6)";
    const values: unknown[] = [quest, photo === null ? "Some words" : null, GUIDELINES];
    values.push(randomUUID(), photo);
    if (onScreen !== undefined) values.push(onScreen);
    const [sent] = await query<{ submission_id: string }>({ playerId: player }, sql, values);
    return sent?.submission_id ?? "";
  };
  const review = (
    event: string,
    submission: string,
    decision: "approve" | "reject",
    seat = teamA(),
  ) =>
    query(seat, "SELECT * FROM staff_review_submission($1, $2, $3, $4, $5, $6)", [
      event,
      submission,
      decision,
      decision === "reject" ? "Blurry" : null,
      randomUUID(),
      randomUUID(),
    ]);
  /** A member's photo, sent with `onScreen` and approved unless `approve` is false. */
  const photo = async (
    event: string,
    quest: string,
    options: { onScreen?: boolean; approve?: boolean; org?: string } = {},
  ): Promise<Photo> => {
    const org = options.org ?? ids.orgA;
    const who = await member(event, org);
    const slot = await upload(who.player, quest);
    const submission = await send(who.player, quest, slot.id, options.onScreen ?? true);
    if (options.approve !== false) {
      await review(event, submission, "approve", org === ids.orgA ? teamA() : teamB());
    }
    return { ...who, submission, media: slot.id, key: slot.key };
  };
  const pick = (event: string, submissions: string[], seat = teamA()) =>
    query(seat, "SELECT set_photo_wall($1, $2, $3) AS n", [event, submissions, randomUUID()]);
  const device = async (event: string, kind = "screen", seat = teamA()) => {
    const pending = { secret: hash(), code: hash() };
    await query({}, "SELECT * FROM open_device_request($1, $2, $3, 'Chrome on Android')", [
      pending.secret,
      pending.code,
      kind,
    ]);
    const quest =
      kind === "station"
        ? ((
            await owner<{ id: string }>(
              `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
               SELECT $1, c.id, 'scan_qr', 'Gate', 10, ARRAY['screen_qr'] FROM category c WHERE c.event_id = $1
               LIMIT 1 RETURNING id`,
              [event],
            )
          )[0]?.id ?? null)
        : null;
    const [claimed] = await query<{ id: string }>(
      seat,
      "SELECT team_claim_device($1, $2, $3, $4, 'Hall TV', $5) AS id",
      [pending.code, event, kind, quest, randomUUID()],
    );
    await query({}, "SELECT activate_device($1, $2)", [pending.secret, hash()]);
    return claimed?.id ?? "";
  };
  const screenWall = async (deviceId: string): Promise<Wall> =>
    (await query<{ r: Wall }>({ deviceId }, "SELECT screen_photos() AS r"))[0]?.r as Wall;
  const onScreen = async (deviceId: string): Promise<string[]> =>
    ((await screenWall(deviceId)).photos ?? []).map((one) => one.mediaId);
  const appWall = async (player: string, event: string) =>
    query<{ media_id: string; photo_key: string; username: string }>(
      { playerId: player },
      "SELECT * FROM member_photo_wall($1)",
      [event],
    );
  const consent = (player: string, event: string, submission: string, allowed: boolean) =>
    query({ playerId: player }, "SELECT own_photo_on_screen($1, $2, $3) AS r", [
      event,
      submission,
      allowed,
    ]);

  describe("consent at the send", () => {
    it("stores the player's choice, false from an older API's five-argument call and for text", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["text", "photo"]);
      const yes = await photo(event, quest, { onScreen: true, approve: false });
      const no = await photo(event, quest, { onScreen: false, approve: false });
      const older = await member(event);
      const slot = await upload(older.player, quest);
      const old = await send(older.player, quest, slot.id);
      const words = await member(event);
      const text = await send(words.player, quest, null, true);
      const stored = await owner<{ id: string; on_screen: boolean }>(
        "SELECT id::text, on_screen FROM submission WHERE id = ANY ($1::bigint[]) ORDER BY id",
        [[yes.submission, no.submission, old, text]],
      );
      expect(stored.map((row) => row.on_screen)).toEqual([true, false, false, false]);
      const [mine] = await query<{ on_screen: boolean }>(
        { playerId: yes.player },
        "SELECT * FROM own_submissions($1)",
        [event],
      );
      expect(mine?.on_screen).toBe(true);
    });

    it("refuses on_screen for a text submission at the table", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["text"]);
      const words = await member(event);
      const sent = await send(words.player, quest, null, false);
      expect(
        await refusal(owner("UPDATE submission SET on_screen = true WHERE id = $1", [sent])),
      ).toMatch(/^23514/);
    });
  });

  describe("the team's pick", () => {
    it("lists eligible photos, saves an ordered pick and the screen shows it in that order, keys only", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const first = await photo(event, quest);
      const second = await photo(event, quest);
      const waiting = await photo(event, quest, { approve: false });
      const candidates = await query<{ submission_id: string; photo_key: string }>(
        teamA(),
        "SELECT * FROM event_wall_candidates($1, NULL, 50)",
        [event],
      );
      expect(candidates.map((row) => row.submission_id)).toEqual([
        second.submission,
        first.submission,
      ]);
      expect(candidates[0]?.photo_key).toBe(second.key);
      expect(candidates.map((row) => row.submission_id)).not.toContain(waiting.submission);
      expect((await pick(event, [second.submission, first.submission]))[0]?.["n"]).toBe(2);
      const picked = await query<{ submission_id: string }>(
        teamA(),
        "SELECT * FROM event_photo_wall($1)",
        [event],
      );
      expect(picked.map((row) => row.submission_id)).toEqual([second.submission, first.submission]);
      const wall = await screenWall(await device(event));
      expect(wall).toEqual({
        shut: null,
        photos: [
          { mediaId: second.media, key: second.key },
          { mediaId: first.media, key: first.key },
        ],
      });
      const [audit] = await owner<{ after: Row }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'photo_wall.update' ORDER BY id DESC LIMIT 1",
        [event],
      );
      expect(audit?.after).toEqual({
        submissions: [Number(second.submission), Number(first.submission)],
      });
    });

    it("refuses a photo that is not eligible, repeated ids and more than 20 (PW422)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const ok = await photo(event, quest);
      const waiting = await photo(event, quest, { approve: false });
      const private_ = await photo(event, quest, { onScreen: false });
      expect(await refusal(pick(event, [waiting.submission]))).toBe("PW422:not_eligible");
      expect(await refusal(pick(event, [private_.submission]))).toBe("PW422:not_eligible");
      expect(await refusal(pick(event, [ok.submission, ok.submission]))).toBe("PW422:picks");
      const many = Array.from({ length: 21 }, () => ok.submission);
      expect(await refusal(pick(event, many))).toBe("PW422:picks");
      expect(await refusal(pick(event, ["999999999"]))).toBe("PW422:not_eligible");
    });

    it("ties a pick to its event: another event's photo is PW422, and the table refuses a mismatch (B1)", async () => {
      const event = await newEvent();
      const sibling = await newEvent();
      const foreign = await newEvent({ org: ids.orgB });
      const mine = await photo(event, await newQuest(event));
      const theirs = await photo(sibling, await newQuest(sibling));
      const far = await photo(foreign, await newQuest(foreign), { org: ids.orgB });
      expect(await refusal(pick(event, [theirs.submission]))).toBe("PW422:not_eligible");
      expect(await refusal(pick(event, [far.submission]))).toBe("PW422:not_eligible");
      expect(
        await refusal(
          owner(
            `INSERT INTO photo_wall (event_id, organizer_id, submission_id, position)
             VALUES ($1, $2, $3, 1)`,
            [event, ids.orgA, theirs.submission],
          ),
        ),
      ).toMatch(/^23503/);
      await pick(event, [mine.submission]);
      expect(await onScreen(await device(event))).toEqual([mine.media]);
    });

    it("keeps another organizer's team and an add-on that is off out", async () => {
      const event = await newEvent();
      const ok = await photo(event, await newQuest(event));
      expect(await refusal(pick(event, [ok.submission], teamB()))).toBe("AN404");
      expect(
        await refusal(query(teamB(), "SELECT * FROM event_wall_candidates($1, NULL, 50)", [event])),
      ).toBe("AN404");
      expect(await refusal(query(teamB(), "SELECT * FROM event_photo_wall($1)", [event]))).toBe(
        "AN404",
      );
      const bare = await newEvent({ addon: false });
      expect(await refusal(pick(bare, []))).toBe("BS403");
    });
  });

  describe("every rule takes a photo off at the next read", () => {
    const wallOf = async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const screen = await device(event);
      const viewer = await member(event);
      return { event, quest, screen, viewer };
    };
    const shownAfter = async (
      change: (wall: Awaited<ReturnType<typeof wallOf>>, one: Photo) => Promise<unknown>,
    ) => {
      const wall = await wallOf();
      const one = await photo(wall.event, wall.quest);
      await pick(wall.event, [one.submission]);
      expect(await onScreen(wall.screen)).toEqual([one.media]);
      await change(wall, one);
      const app = await appWall(wall.viewer.player, wall.event);
      return { screen: await onScreen(wall.screen), app: app.map((row) => row.media_id) };
    };

    it("not allowed: the player withdrew, and it stays off until a new pick", async () => {
      const wall = await wallOf();
      const one = await photo(wall.event, wall.quest);
      await pick(wall.event, [one.submission]);
      await consent(one.player, wall.event, one.submission, false);
      expect(await onScreen(wall.screen)).toEqual([]);
      expect(
        await owner("SELECT 1 FROM photo_wall WHERE submission_id = $1", [one.submission]),
      ).toHaveLength(0);
      await consent(one.player, wall.event, one.submission, true);
      expect(await onScreen(wall.screen)).toEqual([]);
      await pick(wall.event, [one.submission]);
      expect(await onScreen(wall.screen)).toEqual([one.media]);
    });

    it("rejected is never eligible", async () => {
      const wall = await wallOf();
      const one = await photo(wall.event, wall.quest, { approve: false });
      await review(wall.event, one.submission, "reject");
      expect(await refusal(pick(wall.event, [one.submission]))).toBe("PW422:not_eligible");
    });

    it("removed by the team", async () => {
      const seen = await shownAfter(({ event }, one) =>
        query(teamA(), "SELECT * FROM remove_submission($1, $2, 'Not right', $3, $4)", [
          event,
          one.submission,
          randomUUID(),
          randomUUID(),
        ]),
      );
      expect(seen).toEqual({ screen: [], app: [] });
    });

    it("erased account", async () => {
      const seen = await shownAfter((_wall, one) =>
        owner("UPDATE submission SET erased_at = now(), body = NULL WHERE id = $1", [
          one.submission,
        ]),
      );
      expect(seen).toEqual({ screen: [], app: [] });
    });

    it("banned player", async () => {
      const seen = await shownAfter((_wall, one) =>
        owner("UPDATE player SET status = 'banned' WHERE id = $1", [one.player]),
      );
      expect(seen).toEqual({ screen: [], app: [] });
    });

    it("left the event", async () => {
      const seen = await shownAfter((_wall, one) =>
        owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [one.enrollment]),
      );
      expect(seen).toEqual({ screen: [], app: [] });
    });

    it("the photo held by Questify, back after a republish", async () => {
      const wall = await wallOf();
      const one = await photo(wall.event, wall.quest);
      await pick(wall.event, [one.submission]);
      await query(admin(), "SELECT * FROM admin_unpublish('media', $1, 'sexual', $2, $3)", [
        one.media,
        "Not for the room screen",
        randomUUID(),
      ]);
      expect(await onScreen(wall.screen)).toEqual([]);
      expect(await appWall(wall.viewer.player, wall.event)).toEqual([]);
      await query(admin(), "SELECT admin_republish('media', $1, $2, $3)", [
        one.media,
        "Checked again, fine",
        randomUUID(),
      ]);
      expect(await onScreen(wall.screen)).toEqual([one.media]);
    });

    it("the quest held by Questify", async () => {
      const seen = await shownAfter(({ quest }) =>
        query(admin(), "SELECT * FROM admin_unpublish('quest', $1, 'spam', $2, $3)", [
          quest,
          "Quest under review now",
          randomUUID(),
        ]),
      );
      expect(seen).toEqual({ screen: [], app: [] });
    });

    it("pending is never eligible", async () => {
      const wall = await wallOf();
      const one = await photo(wall.event, wall.quest, { approve: false });
      expect(await refusal(pick(wall.event, [one.submission]))).toBe("PW422:not_eligible");
      await owner(
        "INSERT INTO photo_wall (event_id, organizer_id, submission_id, position) VALUES ($1, $2, $3, 1)",
        [wall.event, ids.orgA, one.submission],
      );
      expect(await onScreen(wall.screen)).toEqual([]);
    });
  });

  describe("the consent door (M6)", () => {
    it("is the player's own photo submission of that event only", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const quest = await newQuest(event, ["text", "photo"]);
      const one = await photo(event, quest, { approve: false });
      const stranger = await member(event);
      expect(await refusal(consent(stranger.player, event, one.submission, false))).toBe("PW404");
      expect(await refusal(consent(one.player, other, one.submission, false))).toBe("PW404");
      const text = await send(stranger.player, quest, null, false);
      expect(await refusal(consent(stranger.player, event, text, true))).toBe("PW422:not_photo");
      expect((await consent(one.player, event, one.submission, false))[0]?.["r"]).toBe(false);
      expect(
        (
          await owner<{ on_screen: boolean }>("SELECT on_screen FROM submission WHERE id = $1", [
            one.submission,
          ])
        )[0]?.on_screen,
      ).toBe(false);
    });
  });

  describe("the app's wall", () => {
    it("hides a photo of a player the reader blocked, names usernames only", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const a = await photo(event, quest);
      const b = await photo(event, quest);
      const viewer = await member(event);
      await pick(event, [a.submission, b.submission]);
      const before = await appWall(viewer.player, event);
      expect(before.map((row) => row.media_id)).toEqual([a.media, b.media]);
      expect(Object.keys(before[0] ?? {}).toSorted()).toEqual([
        "media_id",
        "photo_key",
        "username",
      ]);
      await owner("INSERT INTO player_block (blocker_id, blocked_id) VALUES ($1, $2)", [
        viewer.player,
        a.player,
      ]);
      expect((await appWall(viewer.player, event)).map((row) => row.media_id)).toEqual([b.media]);
    });

    it("refuses while the photo scene is not running or the screen is shut, and to a non-member", async () => {
      const unpicked = await newEvent({ scenes: ["ranking"] });
      const viewer = await member(unpicked);
      expect(await refusal(appWall(viewer.player, unpicked))).toBe("PW404");
      const event = await newEvent();
      const inside = await member(event);
      expect(await appWall(inside.player, event)).toEqual([]);
      await owner("DELETE FROM event_entitlement WHERE event_id = $1", [event]);
      expect(await refusal(appWall(inside.player, event))).toBe("PW404");
      const outsider = await member(await newEvent());
      expect(await refusal(appWall(outsider.player, event))).toBe("AM403");
      expect(
        (
          await query<{ on: boolean }>(
            { playerId: inside.player },
            "SELECT member_photo_wall_on($1) AS on",
            [event],
          )
        )[0]?.on,
      ).toBe(false);
      expect(
        (
          await query<{ on: boolean }>(
            { playerId: outsider.player },
            "SELECT member_photo_wall_on($1) AS on",
            [event],
          )
        )[0]?.on,
      ).toBe(false);
    });
  });

  describe("the screen's read", () => {
    it("reads its own event only; a station is DV401; no scene picked answers no photos", async () => {
      const event = await newEvent();
      const foreign = await newEvent({ org: ids.orgB });
      const mine = await photo(event, await newQuest(event));
      const theirs = await photo(foreign, await newQuest(foreign), { org: ids.orgB });
      await pick(event, [mine.submission]);
      await pick(foreign, [theirs.submission], teamB());
      expect(await onScreen(await device(foreign, "screen", teamB()))).toEqual([theirs.media]);
      expect(await onScreen(await device(event))).toEqual([mine.media]);
      expect(await refusal(screenWall(await device(event, "station")))).toBe("DV401");
      expect(await refusal(query({ playerId: mine.player }, "SELECT screen_photos()"))).not.toBe(
        "none",
      );
      await query(teamA(), "SELECT set_big_screen($1, $2, $3)", [event, ["ranking"], randomUUID()]);
      expect(await screenWall(await device(event))).toEqual({ shut: null, photos: [] });
    });

    it("takes photo as a fourth scene, at most once", async () => {
      const event = await newEvent({ scenes: ["ranking", "community", "poll", "photo"] });
      const [json] = await query<{ r: { scenes: string[]; offered: string[] } }>(
        teamA(),
        "SELECT event_big_screen($1) AS r",
        [event],
      );
      expect(json?.r.scenes).toEqual(["ranking", "community", "poll", "photo"]);
      expect(json?.r.offered).toContain("photo");
      expect(
        await refusal(
          query(teamA(), "SELECT set_big_screen($1, $2, $3)", [
            event,
            ["photo", "photo"],
            randomUUID(),
          ]),
        ),
      ).toBe("BS422:scenes");
    });
  });

  describe("reports and holds (M1)", () => {
    it("reports a photo on the reader's wall, keeps the quest title, and RP404 once it is off", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const one = await photo(event, quest);
      const off = await photo(event, quest);
      const viewer = await member(event);
      await pick(event, [one.submission]);
      const report = (target: string) =>
        query<{ r: string }>(
          { playerId: viewer.player },
          "SELECT report_content('media', $1, NULL, NULL, 'sexual', NULL) AS r",
          [target],
        );
      expect((await report(one.media))[0]?.r).toBe("reported");
      expect(await refusal(report(off.media))).toBe("RP404");
      const [stored] = await owner<{ snapshot: Row; event_id: string }>(
        "SELECT snapshot, event_id FROM content_report WHERE target_kind = 'media' AND target_id = $1",
        [one.media],
      );
      expect(stored).toEqual({
        snapshot: { title: { ar: "صورة الفريق", en: "Team photo" } },
        event_id: event,
      });
      const [key] = await query<{ k: string }>(admin(), "SELECT admin_report_media_key($1) AS k", [
        one.media,
      ]);
      expect(key?.k).toBe(one.key);
      expect(
        await refusal(query(teamA(), "SELECT admin_report_media_key($1)", [one.media])),
      ).not.toBe("none");
      const [unreported] = await query<{ k: string | null }>(
        admin(),
        "SELECT admin_report_media_key($1) AS k",
        [off.media],
      );
      expect(unreported?.k).toBeNull();
    });

    it("unpublish closes the reports; resolve accepts unpublished for media", async () => {
      const event = await newEvent();
      const one = await photo(event, await newQuest(event));
      const viewer = await member(event);
      await pick(event, [one.submission]);
      await query(
        { playerId: viewer.player },
        "SELECT report_content('media', $1, NULL, NULL, 'spam', NULL)",
        [one.media],
      );
      expect(
        await refusal(
          query(admin(), "SELECT admin_report_resolve('media', $1, 'unpublished', $2)", [
            one.media,
            randomUUID(),
          ]),
        ),
      ).toBe("RP409");
      const [held] = await query<{ outcome: string }>(
        admin(),
        "SELECT * FROM admin_unpublish('media', $1, 'spam', $2, $3)",
        [one.media, "Spam on the wall here", randomUUID()],
      );
      expect(held?.outcome).toBe("unpublished");
      const [report] = await owner<{ status: string; outcome: string }>(
        "SELECT status, outcome FROM content_report WHERE target_id = $1",
        [one.media],
      );
      expect(report).toEqual({ status: "actioned", outcome: "unpublished" });
      expect(
        await refusal(
          query(admin(), "SELECT * FROM admin_unpublish('media', $1, 'spam', $2, $3)", [
            randomUUID(),
            "Nothing is there at all",
            randomUUID(),
          ]),
        ),
      ).toBe("HD404");
    });
  });
});
