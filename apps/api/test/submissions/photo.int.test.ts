import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObjectStore } from "#src/storage/client";
import { startMediaWorker } from "#src/storage/worker";
import { startFakeS3, type FakeS3 } from "#test/storage/fake-s3";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

const GUIDELINES = "0.1";

/**
 * Photo submissions and ticket photos over HTTP on the S3 double (T-301b): the upload door, the stored object (re-encoded,
 * no EXIF, under the event's prefix), the submit, the team's and the operator's signed reads, the worker deleting a
 * rejected photo, idempotent repeats, the refusals (type, size, kind, another player's photo), and photos off.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("photo submissions over HTTP", () => {
  let db: TestDatabase;
  let fake: FakeS3;
  let test: TestApp;
  let off: TestApp;
  let pool: Pool;
  let organizer = "";
  let ownerCookie = "";
  let offCookie = "";
  let counter = 0;
  let jpeg: Buffer;

  beforeAll(async () => {
    db = await createTestDatabase();
    fake = await startFakeS3();
    const storage = createObjectStore(fake.settings, { retryDelayMs: 1 });
    test = await startApp(db, false, {}, { storage });
    off = await startApp(db);
    pool = new Pool({ connectionString: db.appUrl, max: 2 });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('photo-org', 'photo-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@photo.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@photo.test");
    offCookie = await signInFully(off, "owner@photo.test");
    jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#2a6" } })
      .withExif({ IFD0: { Make: "QuestifyCam" }, IFD3: { GPSLatitudeRef: "N" } })
      .jpeg()
      .toBuffer();
  });
  afterAll(async () => {
    await test.close();
    await off.close();
    await pool.end();
    await fake.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Photo Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `PHTH${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, accepts: string[] = ["photo"]) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'submission', 'Show us', 80, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, JSON.stringify({ accepts, autoApprove: false, resubmit: true })],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`photo_http_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    await owner(
      `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'community_guidelines', $2, 'submission')`,
      [id, GUIDELINES],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      organizer,
      event,
      id,
    ]);
    return { id, token };
  };
  const upload = (
    path: string,
    token: string,
    body: Buffer,
    type = "image/jpeg",
    key: string = randomUUID(),
    on: TestApp = test,
  ) =>
    on.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "content-type": type },
      payload: body,
    });
  const json = (method: "GET" | "POST", path: string, token: string, payload?: object) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (method: "GET" | "POST", path: string, payload?: object, on = test) =>
    on.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(on === test ? ownerCookie : offCookie, {
        "idempotency-key": randomUUID(),
      }),
      ...(payload === undefined ? {} : { payload }),
    });

  it("stores a re-encoded JPEG under the event's prefix, and the team reads it through a 5-minute URL", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, ["text", "photo"]);
    const sara = await newPlayer(event);
    const sent = await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg);
    expect(sent.statusCode).toBe(201);
    const { photoId } = sent.json<{ photoId: string }>();
    const key = `o/${organizer}/e/${event}/submission/${photoId}.jpg`;
    const stored = fake.objects.get(key);
    expect(stored?.contentType).toBe("image/jpeg");
    const meta = await sharp(stored?.body).metadata();
    expect([meta.format, meta.width, meta.exif]).toEqual(["jpeg", 640, undefined]);

    const submitted = await json("POST", `/v1/quests/${quest}/submit`, sara.token, {
      photoId,
      text: "By the stage",
    });
    expect([submitted.statusCode, submitted.json().status]).toEqual([201, "pending"]);
    const mine = await json("GET", `/v1/events/${event}/submissions/mine`, sara.token);
    expect(mine.json().submissions[0]).toMatchObject({
      kind: "photo",
      text: "By the stage",
      photoGone: false,
    });
    expect(JSON.stringify(mine.json())).not.toContain(photoId);

    const queue = await dashboard("GET", `/events/${event}/submissions`);
    expect(queue.headers["cache-control"]).toBe("no-store");
    const [item] = queue.json<{ submissions: Row[] }>().submissions;
    expect(item).toMatchObject({ kind: "photo", text: "By the stage", photoGone: false });
    const url = new URL(String(item?.["photoUrl"]));
    expect(url.origin).toBe(fake.settings.endpoint);
    expect(url.pathname).toBe(`/${fake.settings.bucket}/${key}`);
    const expires = new Date(String(item?.["photoExpiresAt"])).getTime() - Date.now();
    expect(expires).toBeGreaterThan(280_000);
    expect(expires).toBeLessThanOrEqual(300_000);
    const read = await fetch(url);
    expect([read.status, read.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
  });

  it("deletes a rejected photo from the bucket in one worker run, and says it is gone", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const { photoId } = (await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg)).json<{
      photoId: string;
    }>();
    const sent = await json("POST", `/v1/quests/${quest}/submit`, sara.token, { photoId });
    const key = `o/${organizer}/e/${event}/submission/${photoId}.jpg`;
    expect(fake.objects.has(key)).toBe(true);
    const reviewed = await dashboard(
      "POST",
      `/events/${event}/submissions/${String(sent.json().submissionId)}/review`,
      { decision: "reject", reason: "Blurry" },
    );
    expect(reviewed.statusCode).toBe(200);
    const worker = startMediaWorker({
      pool,
      store: createObjectStore(fake.settings, { retryDelayMs: 1 }),
      intervalMs: 3_600_000,
      log: () => undefined,
    });
    expect((await worker.runOnce()).deleted).toBeGreaterThanOrEqual(1);
    await worker.stop();
    expect(fake.objects.has(key)).toBe(false);
    const done = await dashboard("GET", `/events/${event}/submissions?filter=done`);
    expect(done.json().submissions[0]).toMatchObject({ photoUrl: null, photoGone: true });
  });

  it("stores one object for a repeated upload, and refuses the key with other bytes", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const before = fake.objects.size;
    const key = randomUUID();
    const first = await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg, "image/jpeg", key);
    const again = await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg, "image/jpeg", key);
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(again.json()).toEqual(first.json());
    expect(fake.objects.size).toBe(before + 1);
    const png = await sharp(jpeg).png().toBuffer();
    const other = await upload(`/v1/quests/${quest}/photo`, sara.token, png, "image/png", key);
    expect([other.statusCode, other.json().code]).toEqual([422, "idempotency_key_reused"]);
  });

  it("refuses what is not a JPEG, PNG or WebP, a photo over 8 MB, and a text-only quest", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const path = `/v1/quests/${quest}/photo`;
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftypheic"),
      Buffer.alloc(64),
    ]);
    for (const [body, type, status, code] of [
      [heic, "image/jpeg", 415, "photo_type"],
      [
        Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(64)]),
        "image/png",
        415,
        "photo_type",
      ],
      [jpeg.subarray(0, 300), "image/jpeg", 422, "photo_unreadable"],
      [Buffer.alloc(8 * 1024 * 1024 + 1, 0xff), "image/jpeg", 413, "photo_too_large"],
    ] as const) {
      const refused = await upload(path, sara.token, body, type);
      expect([refused.statusCode, refused.json().code], code).toEqual([status, code]);
    }
    const plain = await upload(path, sara.token, Buffer.from("hello"), "text/plain");
    expect(plain.statusCode).toBe(415);
    const textOnly = await newQuest(event, ["text"]);
    const wrong = await upload(`/v1/quests/${textOnly}/photo`, sara.token, jpeg);
    expect([wrong.statusCode, wrong.json().code]).toEqual([422, "photo_not_accepted"]);
    const needs = await json("POST", `/v1/quests/${quest}/submit`, sara.token, { text: "Words" });
    expect([needs.statusCode, needs.json().code]).toEqual([422, "photo_required"]);
    const neither = await json("POST", `/v1/quests/${quest}/submit`, sara.token, {});
    expect(neither.statusCode).toBe(400);
  });

  it("refuses another player's photo, and caps uploads not yet used at 5 in 30 minutes", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const omar = await newPlayer(event);
    const { photoId } = (await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg)).json<{
      photoId: string;
    }>();
    const taken = await json("POST", `/v1/quests/${quest}/submit`, omar.token, { photoId });
    expect([taken.statusCode, taken.json().code]).toEqual([422, "photo_unusable"]);
    for (let n = 0; n < 4; n += 1) {
      expect((await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg)).statusCode).toBe(201);
    }
    const capped = await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg);
    expect([capped.statusCode, capped.json().code]).toEqual([429, "too_many_photos"]);
    expect(Number(capped.headers["retry-after"])).toBeGreaterThan(1700);
  });

  it("lets a reviewing operator see the photo, and attaches a photo to a help ticket the team sees", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const reviewer = await newPlayer(event);
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [organizer, event, reviewer.id, ["review", "help_desk"]],
    );
    const { photoId } = (await upload(`/v1/quests/${quest}/photo`, sara.token, jpeg)).json<{
      photoId: string;
    }>();
    await json("POST", `/v1/quests/${quest}/submit`, sara.token, { photoId });
    const queue = await json("GET", `/v1/operator/events/${event}/submissions`, reviewer.token);
    expect(queue.headers["cache-control"]).toBe("no-store");
    expect(String(queue.json().submissions[0]?.photoUrl)).toContain(`/submission/${photoId}.jpg`);

    const ticketPhoto = await upload(`/v1/events/${event}/tickets/photo`, sara.token, jpeg);
    expect(ticketPhoto.statusCode).toBe(201);
    const ticketPhotoId = ticketPhoto.json<{ photoId: string }>().photoId;
    expect(fake.objects.has(`o/${organizer}/e/${event}/ticket/${ticketPhotoId}.jpg`)).toBe(true);
    const opened = await json("POST", `/v1/events/${event}/tickets`, sara.token, {
      kind: "problem",
      text: "The screen is broken",
      photoId: ticketPhotoId,
    });
    expect(opened.statusCode).toBe(201);
    const listed = await dashboard("GET", `/events/${event}/tickets`);
    expect(String(listed.json().tickets[0]?.photoUrl)).toContain(`/ticket/${ticketPhotoId}.jpg`);
    const inbox = await json("GET", `/v1/operator/events/${event}/inbox`, reviewer.token);
    expect(inbox.json().items.map((one: Row) => one["hasPhoto"])).toEqual([true, true]);
    const one = await json(
      "GET",
      `/v1/operator/events/${event}/tickets/${String(opened.json().ticket.id)}`,
      reviewer.token,
    );
    expect(one.headers["cache-control"]).toBe("no-store");
    expect(String(one.json().ticket.photoUrl)).toContain(`/ticket/${ticketPhotoId}.jpg`);
    const reused = await json("POST", `/v1/events/${event}/tickets`, sara.token, {
      kind: "question",
      text: "Again",
      photoId: ticketPhotoId,
    });
    expect([reused.statusCode, reused.json().code]).toEqual([422, "photo_unusable"]);
  });

  it("offers photo quests only with a bucket, and answers photos_off without one", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const refused = await upload(
      `/v1/quests/${quest}/photo`,
      sara.token,
      jpeg,
      "image/jpeg",
      randomUUID(),
      off,
    );
    expect([refused.statusCode, refused.json().code]).toEqual([503, "photos_off"]);
    expect((await dashboard("GET", `/events/${event}/quests`, undefined, off)).json().photos).toBe(
      false,
    );
    expect((await dashboard("GET", `/events/${event}/quests`)).json().photos).toBe(true);
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [event],
    );
    const body = {
      categoryId: category?.id,
      type: "submission",
      title: { en: "Show us" },
      points: 50,
      config: { accepts: ["text", "photo"] },
    };
    const offMade = await dashboard("POST", `/events/${event}/quests`, body, off);
    expect([offMade.statusCode, offMade.json().code]).toEqual([422, "submission_kind_unavailable"]);
    const made = await dashboard("POST", `/events/${event}/quests`, body);
    expect(made.statusCode).toBe(201);
    expect(made.json().quest.config.accepts).toEqual(["text", "photo"]);
    const id = String(made.json().quest.id);
    const { photoId } = (await upload(`/v1/quests/${id}/photo`, sara.token, jpeg)).json<{
      photoId: string;
    }>();
    await json("POST", `/v1/quests/${id}/submit`, sara.token, { photoId });
    const locked = await test.app.inject({
      method: "PATCH",
      url: `/v1/organizers/${organizer}/events/${event}/quests/${id}`,
      headers: withSession(ownerCookie),
      payload: { config: { accepts: ["photo"] }, confirm: true },
    });
    expect([locked.statusCode, locked.json().code]).toEqual([409, "accepts_locked"]);
  });

  it("refuses a change set's photo quest without a bucket, as the builder does", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, ["text"]);
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [event],
    );
    const photoAccepts = { config: { accepts: ["text", "photo"] } };
    const items = [
      {
        op: "add",
        target: "quest",
        body: {
          categoryId: category?.id,
          type: "submission",
          title: { en: "Snap" },
          points: 5,
          ...photoAccepts,
        },
      },
      { op: "edit", target: "quest", targetId: quest, body: photoAccepts },
      { op: "edit", target: "quest", targetId: quest, body: { title: { en: "Renamed" } } },
    ];
    type Opened = { items: { id: string; state: string; problem: { code: string } | null }[] };
    const openOn = async (on: TestApp) => {
      const made = await dashboard("POST", `/events/${event}/change-sets`, { items }, on);
      expect(made.statusCode, made.body).toBe(201);
      const set = made.json<{ changeSet: { id: string } }>().changeSet.id;
      const opened = await dashboard("GET", `/events/${event}/change-sets/${set}`, undefined, on);
      return { set, opened: opened.json<{ changeSet: Opened }>().changeSet };
    };
    const off1 = await openOn(off);
    expect(off1.opened.items.map((item) => [item.state, item.problem?.code ?? null])).toEqual([
      ["invalid", "submission_kind_unavailable"],
      ["invalid", "submission_kind_unavailable"],
      ["ready", null],
    ]);
    const on1 = await openOn(test);
    expect(on1.opened.items.map((item) => item.state)).toEqual(["ready", "ready", "ready"]);
    // An apply on the server with no bucket refuses the photo items and applies the rest.
    const offIds = off1.opened.items.map((item) => item.id);
    const applied = await dashboard(
      "POST",
      `/events/${event}/change-sets/${off1.set}/apply`,
      { itemIds: offIds },
      off,
    );
    expect(applied.statusCode, applied.body).toBe(200);
    expect(
      applied.json<{ results: { status: string; error: { code: string } | null }[] }>().results,
    ).toMatchObject([
      { status: "failed", error: { code: "submission_kind_unavailable" } },
      { status: "failed", error: { code: "submission_kind_unavailable" } },
      { status: "applied" },
    ]);
    const [stored] = await owner<{ accepts: string[] }>(
      "SELECT type_config -> 'accepts' AS accepts FROM quest WHERE id = $1",
      [quest],
    );
    expect(stored?.accepts).toEqual(["text"]);
  });
});
