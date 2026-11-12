import { createHash, randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObjectStore } from "#src/storage/client";
import { startFakeS3, type FakeS3 } from "#test/storage/fake-s3";
import {
  DASHBOARD_ORIGIN,
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Response = Readonly<{
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: <T = Row>() => T;
}>;
type Photo = { mediaId?: string; submissionId?: string; url: string; expiresAt: string };

const GUIDELINES = "0.1";
const cookieOf = (response: Response): string => {
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0] ?? "";
};

/**
 * The photo wall over HTTP on the S3 double (T-504b): the player's choice at the send and afterwards, the team's picker,
 * the screen's photo scene and the app's wall (each photo a 120-second URL on the bucket, never a key or a full name),
 * Home's flag, and a server without a bucket, where everything stays off and harmless.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the photo wall over HTTP", () => {
  let db: TestDatabase;
  let fake: FakeS3;
  let test: TestApp;
  let off: TestApp;
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
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('wall-org', 'wall-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@wall.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@wall.test");
    offCookie = await signInFully(off, "owner@wall.test");
    jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#a62" } })
      .jpeg()
      .toBuffer();
  });
  afterAll(async () => {
    await test.close();
    await off.close();
    await fake.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const dashboard = (
    method: "GET" | "POST" | "PUT",
    path: string,
    payload?: object,
    on: TestApp = test,
  ) =>
    on.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(on === test ? ownerCookie : offCookie, {
        "idempotency-key": randomUUID(),
      }),
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;
  const asPlayer = (
    method: "GET" | "POST" | "PUT",
    path: string,
    token: string,
    payload?: object,
    on: TestApp = test,
  ) =>
    on.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;

  /** A live event with the big-screen add-on, the photo scene picked, and one photo quest. */
  const newEvent = async () => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Wall Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `WALH${counter}`],
    );
    const id = event?.id ?? "";
    await owner(
      "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
      [id, organizer],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [id]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       SELECT $1, id, 'submission', 'Team photo', 50, '{"accepts": ["photo"], "autoApprove": true}'
       FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [id],
    );
    const saved = await dashboard("PUT", `/events/${id}/big-screen`, { scenes: ["photo"] });
    expect(saved.statusCode, saved.body).toBe(200);
    return { event: id, quest: quest?.id ?? "" };
  };
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`wall_http_${counter}`],
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
    return { id, token, username: `wall_http_${counter}` };
  };
  /** Uploads and sends one auto-approved photo with the player's choice: its submission and media ids. */
  const sendPhoto = async (quest: string, token: string, onScreen: boolean | undefined) => {
    const uploaded = await test.app.inject({
      method: "POST",
      url: `/v1/quests/${quest}/photo`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": randomUUID(),
        "content-type": "image/jpeg",
      },
      payload: jpeg,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const { photoId } = uploaded.json<{ photoId: string }>();
    const body = onScreen === undefined ? { photoId } : { photoId, onScreen };
    const sent = await asPlayer("POST", `/v1/quests/${quest}/submit`, token, body);
    expect(sent.statusCode, sent.body).toBe(201);
    return { submissionId: String(sent.json()["submissionId"]), mediaId: photoId };
  };
  const screenOf = async (event: string, on: TestApp = test) => {
    const made = await on.app.inject({
      method: "POST",
      url: "/v1/device/pairing",
      headers: { origin: DASHBOARD_ORIGIN, "x-forwarded-for": freshIp() },
      payload: { kind: "screen" },
    });
    const page = { cookie: cookieOf(made as Response), code: made.json<{ code: string }>().code };
    const claimed = await dashboard(
      "POST",
      `/events/${event}/devices`,
      { code: page.code, kind: "screen", questId: null, label: "Hall TV" },
      on,
    );
    expect(claimed.statusCode, claimed.body).toBe(201);
    const activated = await on.app.inject({
      method: "POST",
      url: "/v1/device/activate",
      headers: { cookie: page.cookie, origin: DASHBOARD_ORIGIN },
      payload: {},
    });
    return cookieOf(activated as Response);
  };
  const scene = (cookie: string, on: TestApp = test) =>
    on.app.inject({
      method: "GET",
      url: "/v1/device/screen/photo",
      headers: { cookie, origin: DASHBOARD_ORIGIN },
    }) as Promise<Response>;
  const onBucket = (photo: Photo, mediaKey: string) => {
    const url = new URL(photo.url);
    expect(url.origin).toBe(fake.settings.endpoint);
    expect(url.pathname).toBe(`/${fake.settings.bucket}/${mediaKey}`);
    const left = new Date(photo.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(55_000);
    expect(left).toBeLessThanOrEqual(120_000);
  };

  it("takes the player's choice, lets the team pick, and shows the pick on the screen and in the app", async () => {
    const { event, quest } = await newEvent();
    const sara = await newPlayer(event);
    const viewer = await newPlayer(event);
    const yes = await sendPhoto(quest, sara.token, true);
    const no = await sendPhoto(quest, (await newPlayer(event)).token, undefined);
    const key = `o/${organizer}/e/${event}/submission/${yes.mediaId}.jpg`;

    const mine = await asPlayer("GET", `/v1/events/${event}/submissions/mine`, sara.token);
    expect(mine.json()).toMatchObject({ photoWall: true });
    expect(mine.json<{ submissions: Row[] }>().submissions[0]).toMatchObject({ onScreen: true });

    const picker = await dashboard("GET", `/events/${event}/photo-wall`);
    expect(picker.statusCode, picker.body).toBe(200);
    expect(picker.headers["cache-control"]).toBe("private, no-store");
    const candidates = picker.json<{ candidates: Photo[] }>().candidates;
    expect(candidates.map((one) => one.submissionId)).toEqual([yes.submissionId]);
    onBucket(candidates[0] as Photo, key);
    expect(picker.body).not.toContain('"key"');
    expect(picker.body).not.toContain(sara.username);

    const refused = await dashboard("PUT", `/events/${event}/photo-wall`, {
      submissionIds: [no.submissionId],
    });
    expect([refused.statusCode, refused.json()["code"]]).toEqual([422, "invalid_photo_wall"]);
    const saved = await dashboard("PUT", `/events/${event}/photo-wall`, {
      submissionIds: [yes.submissionId],
    });
    expect([saved.statusCode, saved.json()]).toEqual([200, { picked: 1 }]);

    const screen = await screenOf(event);
    const shown = await scene(screen);
    expect(shown.statusCode, shown.body).toBe(200);
    const photos = shown.json<{ shut: null; photos: Photo[] }>().photos;
    expect(photos.map((one) => one.mediaId)).toEqual([yes.mediaId]);
    onBucket(photos[0] as Photo, key);
    expect(shown.body).not.toContain('"key"');
    expect(shown.body).not.toContain(sara.username);
    expect(Object.keys(photos[0] ?? {}).toSorted()).toEqual(["expiresAt", "mediaId", "url"]);

    const wall = await asPlayer("GET", `/v1/events/${event}/photo-wall`, viewer.token);
    expect(wall.statusCode, wall.body).toBe(200);
    expect(wall.headers["cache-control"]).toBe("no-store");
    expect(wall.json<{ photos: Row[] }>().photos).toEqual([
      expect.objectContaining({ mediaId: yes.mediaId, username: sara.username }),
    ]);
    expect(wall.body).not.toContain('"key"');
    const home = await asPlayer("GET", `/v1/events/${event}/home`, viewer.token);
    expect(home.json()).toMatchObject({ photos: true, photoWall: true });
  });

  it("answers the same URL for two reads within one minute (M2)", async () => {
    const { event, quest } = await newEvent();
    const sara = await newPlayer(event);
    const one = await sendPhoto(quest, sara.token, true);
    await dashboard("PUT", `/events/${event}/photo-wall`, { submissionIds: [one.submissionId] });
    const read = async () =>
      (await asPlayer("GET", `/v1/events/${event}/photo-wall`, sara.token)).json<{
        photos: Photo[];
      }>().photos[0]?.url;
    const first = await read();
    const second = await read();
    // A read on each side of a minute's turn may differ; read again once if so.
    expect(first === second || (await read()) === second).toBe(true);
  });

  it("withdraws a photo at once, and a text or another player's submission is refused", async () => {
    const { event, quest } = await newEvent();
    const sara = await newPlayer(event);
    const other = await newPlayer(event);
    const one = await sendPhoto(quest, sara.token, true);
    await dashboard("PUT", `/events/${event}/photo-wall`, { submissionIds: [one.submissionId] });
    const path = `/v1/events/${event}/submissions/${one.submissionId}/on-screen`;
    const stranger = await asPlayer("PUT", path, other.token, { onScreen: false });
    expect([stranger.statusCode, stranger.json()["code"]]).toEqual([404, "not_found"]);
    const withdrawn = await asPlayer("PUT", path, sara.token, { onScreen: false });
    expect([withdrawn.statusCode, withdrawn.json()]).toEqual([200, { onScreen: false }]);
    const wall = await asPlayer("GET", `/v1/events/${event}/photo-wall`, other.token);
    expect(wall.json()).toEqual({ photos: [] });
    const bad = await asPlayer("PUT", path, sara.token, { onScreen: "yes" });
    expect(bad.statusCode).toBe(400);
  });

  it("stays off and harmless without a bucket: no photo scene offered, an empty scene, Home off", async () => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Bare Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `WALO${counter}`],
    );
    const event = made?.id ?? "";
    await owner(
      "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
      [event, organizer],
    );
    const plan = await dashboard("PUT", `/events/${event}/big-screen`, { scenes: ["photo"] }, off);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json<{ offered: string[] }>().offered).not.toContain("photo");
    const read = await dashboard("GET", `/events/${event}/big-screen`, undefined, off);
    expect(read.json<{ offered: string[] }>().offered).not.toContain("photo");
    const screen = await screenOf(event, off);
    expect((await scene(screen, off)).json()).toEqual({ shut: null, photos: [] });
    const sara = await newPlayer(event);
    const home = await asPlayer("GET", `/v1/events/${event}/home`, sara.token, undefined, off);
    expect(home.json()).toMatchObject({ photos: false, photoWall: false });
    const mine = await asPlayer(
      "GET",
      `/v1/events/${event}/submissions/mine`,
      sara.token,
      undefined,
      off,
    );
    expect(mine.json()).toMatchObject({ photoWall: false });
    const wall = await asPlayer(
      "GET",
      `/v1/events/${event}/photo-wall`,
      sara.token,
      undefined,
      off,
    );
    expect(wall.json()).toEqual({ photos: [] });
  });
});
