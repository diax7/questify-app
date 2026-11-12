import { randomUUID } from "node:crypto";
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
type Slot = { id: string; key: string; stored: boolean };

const GUIDELINES = "1.0";
const SYSTEM: RequestContext = {};

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
 * Photo storage in the database (T-301b, migrations 0192 and 0193): the key that names its own tenant, the upload slots
 * and their cap, the sweep, the delete queue's doors, attaching a photo to a submission or a ticket (and every refusal),
 * and deletion by construction: each path that lets a photo go queues its key exactly once.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("photo storage (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
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

  const newEvent = async (
    options: { org?: string; status?: string; endsIn?: string } = {},
  ): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Photo Fest', $3, now() - interval '400 days', now() + $4::interval) RETURNING id`,
      [
        options.org ?? ids.orgA,
        `PHOT${counter}`,
        options.status ?? "live",
        options.endsIn ?? "1 day",
      ],
    );
    return event?.id ?? "";
  };
  const newQuest = async (
    event: string,
    accepts: string[] = ["photo"],
    options: { autoApprove?: boolean; resubmit?: boolean } = {},
  ): Promise<string> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const config = {
      accepts,
      autoApprove: options.autoApprove ?? false,
      resubmit: options.resubmit ?? false,
    };
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'submission', 'Show us', 100, $3) RETURNING id`,
      [event, category?.id, JSON.stringify(config)],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, org = ids.orgA, via = "code") => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`photo_player_${counter}`],
    );
    const player = made?.id ?? "";
    await owner(
      `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'community_guidelines', $2, 'submission')`,
      [player, GUIDELINES],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [org, event, player, via],
    );
    return { player, enrollment: enrolled?.id ?? "" };
  };

  const reserve = async (player: string, quest: string, key: string = randomUUID()) =>
    (
      await query<Slot>(
        { playerId: player },
        "SELECT * FROM media_reserve('submission', NULL, $1, $2)",
        [quest, key],
      )
    )[0] as Slot;
  const reserveTicket = async (player: string, event: string, key: string = randomUUID()) =>
    (
      await query<Slot>(
        { playerId: player },
        "SELECT * FROM media_reserve('ticket', $1, NULL, $2)",
        [event, key],
      )
    )[0] as Slot;
  const store = async (player: string, slot: Slot) =>
    (
      await query<{ ok: boolean }>(
        { playerId: player },
        "SELECT media_stored($1, $2, 1000, 640, 480) AS ok",
        [slot.id, slot.key],
      )
    )[0]?.ok;
  /** A slot with its object stored, ready to attach. */
  const upload = async (player: string, quest: string) => {
    const slot = await reserve(player, quest);
    await store(player, slot);
    return slot;
  };
  const uploadTicket = async (player: string, event: string) => {
    const slot = await reserveTicket(player, event);
    await store(player, slot);
    return slot;
  };
  const send = async (
    player: string,
    quest: string,
    photo: string | null,
    body: string | null = null,
    key: string = randomUUID(),
  ) =>
    (
      await query<{ submission_id: string; status: string; replayed: boolean }>(
        { playerId: player },
        "SELECT * FROM submit_quest($1, $2, $3, $4, $5)",
        [quest, body, GUIDELINES, key, photo],
      )
    )[0] as { submission_id: string; status: string; replayed: boolean };
  const openTicket = async (player: string, event: string, photo: string | null) =>
    (
      await query<{ ticket_id: string }>(
        { playerId: player },
        "SELECT * FROM open_ticket($1, 'problem', NULL, NULL, 'It broke', $2, $3)",
        [event, randomUUID(), photo],
      )
    )[0] as { ticket_id: string };
  const review = (event: string, submission: string, decision: "approve" | "reject") =>
    query(teamA(), "SELECT * FROM staff_review_submission($1, $2, $3, $4, $5, $6)", [
      event,
      submission,
      decision,
      decision === "reject" ? "Blurry" : null,
      randomUUID(),
      randomUUID(),
    ]);
  const queued = async (key: string) =>
    (await owner<{ n: string }>("SELECT count(*) AS n FROM media_delete WHERE key = $1", [key]))[0]
      ?.n;
  const objectOf = async (id: string) =>
    (await owner<{ state: string }>("SELECT state FROM media_object WHERE id = $1", [id]))[0];
  const photoOf = async (submission: string) =>
    (
      await owner<{ photo: string | null; gone: boolean; kind: string }>(
        "SELECT photo, photo_gone_at IS NOT NULL AS gone, kind FROM submission WHERE id = $1",
        [submission],
      )
    )[0];

  describe("the object rows", () => {
    it("forces the key to name the row's own organizer, event, purpose and id", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const id = randomUUID();
      const insert = (key: string) =>
        owner(
          `INSERT INTO media_object (id, organizer_id, event_id, purpose, key, uploaded_by_player, request_key)
           VALUES ($1, $2, $3, 'submission', $4, $5, $6)`,
          [id, ids.orgA, event, key, player, randomUUID()],
        );
      for (const key of [
        `o/${ids.orgB}/e/${event}/submission/${id}.jpg`,
        `o/${ids.orgA}/e/${ids.eventB}/submission/${id}.jpg`,
        `o/${ids.orgA}/e/${event}/ticket/${id}.jpg`,
        `o/${ids.orgA}/e/${event}/submission/${randomUUID()}.jpg`,
        `x/${ids.orgA}/e/${event}/submission/${id}.jpg`,
      ]) {
        await expect(insert(key), key).rejects.toMatchObject({
          code: "23514",
          constraint: "media_object_key_prefix",
        });
      }
      await insert(`o/${ids.orgA}/e/${event}/submission/${id}.jpg`);
    });
  });

  describe("uploading", () => {
    it("hands a slot keyed under the caller's event, and the same slot to the same key", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const key = randomUUID();
      const slot = await reserve(player, quest, key);
      expect(slot.key).toBe(`o/${ids.orgA}/e/${event}/submission/${slot.id}.jpg`);
      expect(slot.stored).toBe(false);
      expect(await reserve(player, quest, key)).toEqual(slot);
      expect(await store(player, slot)).toBe(true);
      expect(await reserve(player, quest, key)).toEqual({ ...slot, stored: true });
      const ticketQuest = await newQuest(event);
      expect(await refusal(reserve(player, ticketQuest, randomUUID()))).toBe("none");
      expect(await refusal(reserveTicket(player, event, key))).toBe("QK422");
    });

    it("refuses a stranger, another tenant's player, a text-only quest and a closed quest", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const stranger = await member(await newEvent());
      expect(await refusal(reserve(stranger.player, quest))).toBe("QC404");
      expect(await refusal(reserve(ids.playerB, quest))).toBe("QC404");
      expect(await refusal(reserveTicket(ids.playerB, event))).toBe("HT403:not_member");
      const { player } = await member(event);
      const textOnly = await newQuest(event, ["text"]);
      expect(await refusal(reserve(player, textOnly))).toBe("SM422:photo_not_accepted");
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [
        quest,
      ]);
      expect(await refusal(reserve(player, quest))).toBe("QN403:ended");
      expect(
        await refusal(
          query({}, "SELECT * FROM media_reserve('submission', NULL, $1, 'k')", [quest]),
        ),
      ).toBe("42501");
    });

    it("caps unattached slots at 5 per player and event in 30 minutes, and a release frees one", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const slots: Slot[] = [];
      for (let n = 0; n < 5; n += 1) slots.push(await reserve(player, quest));
      const capped = await refusal(reserve(player, quest));
      expect(capped).toMatch(/^MD429:\d+$/);
      expect(Number(capped.split(":")[1])).toBeGreaterThan(1700);
      const other = await member(event);
      expect(await refusal(reserve(other.player, quest))).toBe("none");
      const released = await query<{ ok: boolean }>(
        { playerId: player },
        "SELECT media_release($1) AS ok",
        [slots[0]?.id],
      );
      expect(released).toEqual([{ ok: true }]);
      expect(await queued(slots[0]?.key ?? "")).toBe("1");
      expect(await refusal(reserve(player, quest))).toBe("none");
      expect(
        await query({ playerId: other.player }, "SELECT media_release($1) AS ok", [slots[1]?.id]),
      ).toEqual([{ ok: false }]);
    });

    it("stores only the caller's own slot, and queues the key of a slot swept meanwhile", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const other = await member(event);
      const slot = await reserve(player, quest);
      expect(await refusal(store(other.player, slot))).toBe("SM404");
      expect(await refusal(store(player, { ...slot, key: `${slot.key}x` }))).toBe("SM404");
      await owner(
        "UPDATE media_object SET created_at = now() - interval '31 minutes' WHERE id = $1",
        [slot.id],
      );
      expect(await query(SYSTEM, "SELECT media_sweep_uploads() AS n")).toEqual([{ n: 1 }]);
      await owner("DELETE FROM media_delete WHERE key = $1", [slot.key]);
      expect(await store(player, slot)).toBe(false);
      expect(await queued(slot.key)).toBe("1");
      const stray = {
        id: randomUUID(),
        key: `o/${ids.orgB}/e/${ids.eventB}/ticket/${randomUUID()}.jpg`,
      };
      expect(await refusal(store(player, { ...stray, stored: false }))).toBe("MD422");
    });

    it("sweeps uploads never attached after 30 minutes, and keeps attached and fresh ones", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const old = await upload(player, quest);
      const attached = await upload(player, quest);
      await send(player, quest, attached.id);
      const fresh = await reserve(player, quest);
      await owner(
        "UPDATE media_object SET created_at = now() - interval '31 minutes' WHERE id = ANY ($1)",
        [[old.id, attached.id]],
      );
      expect(await query(SYSTEM, "SELECT media_sweep_uploads() AS n")).toEqual([{ n: 1 }]);
      expect(await objectOf(old.id)).toBeUndefined();
      expect(await queued(old.key)).toBe("1");
      expect(await objectOf(attached.id)).toEqual({ state: "attached" });
      expect(await objectOf(fresh.id)).toEqual({ state: "reserved" });
    });
  });

  describe("attaching to a submission", () => {
    it("sends a photo with an optional caption and attaches it once", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["text", "photo"], { resubmit: true });
      const { player } = await member(event);
      const slot = await upload(player, quest);
      const key = randomUUID();
      const sent = await send(player, quest, slot.id, "  At the stage  ", key);
      expect(sent).toMatchObject({ status: "pending", replayed: false });
      expect(await photoOf(sent.submission_id)).toEqual({
        photo: slot.id,
        gone: false,
        kind: "photo",
      });
      expect(await objectOf(slot.id)).toEqual({ state: "attached" });
      expect(await send(player, quest, slot.id, "At the stage", key)).toMatchObject({
        replayed: true,
      });
      expect(await refusal(send(player, quest, null, "At the stage", key))).toBe("QK422");
      const text = await refusal(send(player, quest, null, "Words only"));
      expect(text).toBe("SP409");
      const long = await upload(player, quest);
      await review(event, sent.submission_id, "reject");
      expect(await refusal(send(player, quest, long.id, "x".repeat(301)))).toBe("SV422:too_long");
      expect(await refusal(send(player, quest, long.id, "x".repeat(300)))).toBe("none");
    });

    it("refuses another player's photo, another event's, an attached one, an old one and the wrong kind", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const other = await member(event);
      const theirs = await upload(other.player, quest);
      expect(await refusal(send(player, quest, theirs.id))).toBe("SM404");
      const elsewhere = await newEvent();
      const elsewhereQuest = await newQuest(elsewhere);
      await member(elsewhere).then(() => undefined);
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [ids.orgA, elsewhere, player],
      );
      const away = await upload(player, elsewhereQuest);
      expect(await refusal(send(player, quest, away.id))).toBe("SM404");
      const forTicket = await uploadTicket(player, event);
      expect(await refusal(send(player, quest, forTicket.id))).toBe("SM404");
      const unstored = await reserve(player, quest);
      expect(await refusal(send(player, quest, unstored.id))).toBe("SM404");
      expect(await refusal(send(player, quest, randomUUID()))).toBe("SM404");
      const mine = await upload(player, quest);
      await owner(
        "UPDATE media_object SET created_at = now() - interval '31 minutes' WHERE id = $1",
        [mine.id],
      );
      expect(await refusal(send(player, quest, mine.id))).toBe("SM404");
      expect(await refusal(send(player, quest, null, "Words"))).toBe("SM422:photo_required");
      const textOnly = await newQuest(event, ["text"]);
      const good = await upload(player, quest);
      expect(await refusal(send(player, textOnly, good.id))).toBe("SM422:photo_not_accepted");
      const sent = await send(player, quest, good.id);
      const again = await newQuest(event);
      expect(await refusal(send(player, again, good.id))).toBe("SM404");
      expect(await photoOf(sent.submission_id)).toMatchObject({ photo: good.id });
    });

    it("keeps the four-argument door for a text send", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["text"]);
      const { player } = await member(event);
      const [sent] = await query<{ status: string }>(
        { playerId: player },
        "SELECT * FROM submit_quest($1, 'Old app', $2, $3)",
        [quest, GUIDELINES, randomUUID()],
      );
      expect(sent?.status).toBe("pending");
    });

    it("fixes what a quest accepts once it has a submission (SA409)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["text", "photo"]);
      await owner(
        `UPDATE quest SET type_config = type_config || '{"accepts": ["photo"]}' WHERE id = $1`,
        [quest],
      );
      const { player } = await member(event);
      await send(player, quest, (await upload(player, quest)).id);
      await expect(
        owner(
          `UPDATE quest SET type_config = type_config || '{"accepts": ["text"]}' WHERE id = $1`,
          [quest],
        ),
      ).rejects.toMatchObject({ code: "SA409" });
      await owner(
        `UPDATE quest SET type_config = type_config || '{"resubmit": true}' WHERE id = $1`,
        [quest],
      );
    });

    it("shows the team the key and the player only the state", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const slot = await upload(player, quest);
      const sent = await send(player, quest, slot.id);
      const [row] = await query<Row>(
        teamA(),
        "SELECT * FROM event_submissions($1, 'pending', NULL, 50)",
        [event],
      );
      expect(row).toMatchObject({
        kind: "photo",
        photo_key: slot.key,
        photo_gone: false,
        body: null,
      });
      const [own] = await query<Row>({ playerId: player }, "SELECT * FROM own_submissions($1)", [
        event,
      ]);
      expect(own).toMatchObject({ kind: "photo", photo_gone: false });
      expect(Object.values(own ?? {})).not.toContain(slot.key);
      await review(event, sent.submission_id, "reject");
      const [done] = await query<Row>(
        teamA(),
        "SELECT * FROM event_submissions($1, 'done', NULL, 50)",
        [event],
      );
      expect(done).toMatchObject({ photo_key: null, photo_gone: true });
      const [after] = await query<Row>({ playerId: player }, "SELECT * FROM own_submissions($1)", [
        event,
      ]);
      expect(after).toMatchObject({ status: "rejected", photo_gone: true });
    });
  });

  const pendingPhoto = async (event: string, quest: string, via = "code") => {
    const { player, enrollment } = await member(event, ids.orgA, via);
    const slot = await upload(player, quest);
    const sent = await send(player, quest, slot.id);
    return { player, enrollment, slot, sent };
  };

  describe("deleting by construction", () => {
    it("queues the photo of a rejection, once, and keeps an approved one", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const rejected = await pendingPhoto(event, quest);
      const approved = await pendingPhoto(event, quest);
      await review(event, rejected.sent.submission_id, "reject");
      await review(event, approved.sent.submission_id, "approve");
      expect(await queued(rejected.slot.key)).toBe("1");
      expect(await objectOf(rejected.slot.id)).toBeUndefined();
      expect(await photoOf(rejected.sent.submission_id)).toEqual({
        photo: null,
        gone: true,
        kind: "photo",
      });
      expect(await queued(approved.slot.key)).toBe("0");
      expect(await objectOf(approved.slot.id)).toEqual({ state: "attached" });
    });

    it("queues the photo of a removal", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const sent = await pendingPhoto(event, quest);
      await review(event, sent.sent.submission_id, "approve");
      await query(teamA(), "SELECT * FROM remove_submission($1, $2, 'Spam', $3, $4)", [
        event,
        sent.sent.submission_id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await queued(sent.slot.key)).toBe("1");
      expect(await photoOf(sent.sent.submission_id)).toMatchObject({ photo: null, gone: true });
    });

    it("queues the photo of a pending submission the system closes when the player leaves", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const sent = await pendingPhoto(event, quest);
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [sent.enrollment]);
      expect(await queued(sent.slot.key)).toBe("1");
    });

    it("queues an erased account's photos, approved ones too", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["photo"], { autoApprove: true });
      const sent = await pendingPhoto(event, quest);
      expect(sent.sent.status).toBe("approved");
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [sent.player, sent.enrollment]);
      expect(await queued(sent.slot.key)).toBe("1");
      expect(await photoOf(sent.sent.submission_id)).toEqual({
        photo: null,
        gone: true,
        kind: "photo",
      });
    });

    it("queues the rehearsal's photos when the wipe deletes their submissions and tickets", async () => {
      const event = await newEvent({ status: "scheduled" });
      await owner(
        "UPDATE event SET starts_at = now() + interval '1 hour', ends_at = now() + interval '1 day' WHERE id = $1",
        [event],
      );
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'HELP-WKMN')",
        [event, ids.orgA],
      );
      const quest = await newQuest(event);
      const sent = await pendingPhoto(event, quest, "rehearsal");
      const ticketPhoto = await uploadTicket(sent.player, event);
      await openTicket(sent.player, event, ticketPhoto.id);
      await owner("SELECT wipe_rehearsal($1, 'go_live', $2)", [event, randomUUID()]);
      expect(await queued(sent.slot.key)).toBe("1");
      expect(await queued(ticketPhoto.key)).toBe("1");
    });

    it("queues a ticket's photo when the ticket is deleted or purged, and keeps it while it is open", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const slot = await uploadTicket(player, event);
      const made = await openTicket(player, event, slot.id);
      expect(await objectOf(slot.id)).toEqual({ state: "attached" });
      expect(await queued(slot.key)).toBe("0");
      await owner("DELETE FROM ticket WHERE id = $1", [made.ticket_id]);
      expect(await queued(slot.key)).toBe("1");

      const ended = await newEvent({ endsIn: "-120 days" });
      const other = await member(ended);
      expect(await refusal(uploadTicket(other.player, ended))).toBe("HT403:sending_closed");
      const id = randomUUID();
      const key = `o/${ids.orgA}/e/${ended}/ticket/${id}.jpg`;
      await owner(
        `INSERT INTO media_object (id, organizer_id, event_id, purpose, key, uploaded_by_player, request_key, state,
                                   bytes, width, height, stored_at, attached_at)
         VALUES ($1, $2, $3, 'ticket', $4, $5, 'old', 'attached', 10, 10, 10, now(), now())`,
        [id, ids.orgA, ended, key, other.player],
      );
      await owner(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key, created_at,
                             photo)
         VALUES ($1, $2, $3, $4, 'question', 'old', 'purge', now() - interval '100 days', $5)`,
        [other.player, ids.orgA, ended, other.enrollment, id],
      );
      expect(await query(SYSTEM, "SELECT purge_ended_tickets(1000) AS n")).toEqual([{ n: 1 }]);
      expect(await queued(key)).toBe("1");
    });

    it("refuses a ticket photo of another player, and replays a ticket with its photo", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const other = await member(event);
      const theirs = await uploadTicket(other.player, event);
      expect(await refusal(openTicket(player, event, theirs.id))).toBe("SM404");
      const mine = await uploadTicket(player, event);
      const key = randomUUID();
      const open = (photo: string | null) =>
        query<{ replayed: boolean }>(
          { playerId: player },
          "SELECT * FROM open_ticket($1, 'question', NULL, NULL, 'Where?', $2, $3)",
          [event, key, photo],
        );
      expect(await open(mine.id)).toMatchObject([{ replayed: false }]);
      expect(await open(mine.id)).toMatchObject([{ replayed: true }]);
      expect(await refusal(open(null))).toBe("QK422");
      const [row] = await query<Row>(
        teamA(),
        "SELECT * FROM event_tickets($1, 'open', NULL, NULL, 50)",
        [event],
      );
      expect(row).toMatchObject({ photo_key: mine.key });
    });

    it("queues both keys when a draft event with an upload and a ticket photo is deleted", async () => {
      const event = await newEvent({ status: "draft" });
      const quest = await newQuest(event);
      const { player, enrollment } = await member(event);
      await owner("UPDATE event SET status = 'live' WHERE id = $1", [event]);
      const upload1 = await reserve(player, quest);
      const ticketPhoto = await uploadTicket(player, event);
      await openTicket(player, event, ticketPhoto.id);
      await owner("UPDATE event SET status = 'draft' WHERE id = $1", [event]);
      await owner("DELETE FROM quest WHERE event_id = $1", [event]);
      await owner("DELETE FROM category WHERE event_id = $1", [event]);
      await owner("DELETE FROM enrollment WHERE id = $1", [enrollment]);
      await owner("DELETE FROM event WHERE id = $1", [event]);
      expect(await queued(upload1.key)).toBe("1");
      expect(await queued(ticketPhoto.key)).toBe("1");
    });

    it("purges every object of an event that ended 365 days ago, and marks the submission's photo gone", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, ["photo"], { autoApprove: true });
      const sent = await pendingPhoto(event, quest);
      const pending = await pendingPhoto(event, await newQuest(event));
      const ticketPhoto = await uploadTicket(sent.player, event);
      await openTicket(sent.player, event, ticketPhoto.id);
      const loose = await reserve(sent.player, quest);
      const keep = await newEvent({ endsIn: "-364 days" });
      expect(await query(SYSTEM, "SELECT media_purge_due(500) AS n")).toEqual([{ n: 0 }]);
      await owner("UPDATE event SET ends_at = now() - interval '366 days' WHERE id = $1", [event]);
      expect(await query(SYSTEM, "SELECT media_purge_due(500) AS n")).toEqual([{ n: 4 }]);
      for (const key of [sent.slot.key, pending.slot.key, ticketPhoto.key, loose.key]) {
        expect(await queued(key), key).toBe("1");
      }
      expect(await photoOf(sent.sent.submission_id)).toEqual({
        photo: null,
        gone: true,
        kind: "photo",
      });
      expect(await photoOf(pending.sent.submission_id)).toEqual({
        photo: null,
        gone: true,
        kind: "photo",
      });
      expect(await owner("SELECT id FROM media_object WHERE event_id = $1", [event])).toEqual([]);
      expect(keep).not.toBe("");
    });
  });

  describe("the delete queue", () => {
    it("leases due keys once, backs off a failure and forgets what is done", async () => {
      await owner("DELETE FROM media_delete");
      await owner(
        "INSERT INTO media_delete (key, organizer_id) VALUES ('o/a/one.jpg', NULL), ('o/a/two.jpg', NULL)",
      );
      const first = await query<{ id: string; key: string }>(
        SYSTEM,
        "SELECT * FROM media_delete_claim(10)",
      );
      expect(first.map((row) => row.key)).toEqual(["o/a/one.jpg", "o/a/two.jpg"]);
      expect(await query(SYSTEM, "SELECT * FROM media_delete_claim(10)")).toEqual([]);
      await query(SYSTEM, "SELECT media_delete_failed($1, 'status_500')", [first[0]?.id]);
      const [later] = await owner<{ attempts: number; soon: boolean; code: string }>(
        `SELECT attempts, due_at > now() + interval '50 seconds' AS soon, last_code AS code
         FROM media_delete WHERE id = $1`,
        [first[0]?.id],
      );
      expect(later).toEqual({ attempts: 1, soon: true, code: "status_500" });
      expect(
        await query(SYSTEM, "SELECT media_delete_done($1::bigint[]) AS n", [[first[1]?.id]]),
      ).toEqual([{ n: 1 }]);
      await owner("UPDATE media_delete SET due_at = now() - interval '1 second' WHERE id = $1", [
        first[0]?.id,
      ]);
      expect(await query(SYSTEM, "SELECT key FROM media_delete_claim(10)")).toEqual([
        { key: "o/a/one.jpg" },
      ]);
    });

    it("refuses every seat but the system's", async () => {
      for (const context of [teamA(), { playerId: ids.playerA }]) {
        for (const sql of [
          "SELECT * FROM media_delete_claim(1)",
          "SELECT media_delete_done('{}')",
          "SELECT media_delete_failed(1, 'x')",
          "SELECT media_sweep_uploads()",
          "SELECT media_purge_due(1)",
        ]) {
          expect(await refusal(query(context, sql)), sql).toBe("42501");
        }
      }
    });
  });
});
