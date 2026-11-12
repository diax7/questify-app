import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BAR_KEYS, DEFAULT_LOOKS, EMPTY_CONTENT, HOME_KEYS, INFO_KEYS } from "@questify/shared";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObjectStore } from "#src/storage/client";
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
type Reply = { statusCode: number; headers: Record<string, unknown>; json: <T = Row>() => T };

const codeOf = (reply: Reply) => [reply.statusCode, reply.json<{ code?: string }>().code];

const layoutWith = (content: object) => ({
  bar: { order: BAR_KEYS, hidden: [] },
  home: { order: [...HOME_KEYS, "card:aaaaaa11"], hidden: ["podium"] },
  info: { order: INFO_KEYS, hidden: ["schedule"] },
  content: { ...EMPTY_CONTENT, ...content },
  looks: DEFAULT_LOOKS,
});
const card = (image: string) => ({
  id: "aaaaaa11",
  kind: "text",
  title: { ar: "", en: "" },
  body: { ar: "", en: "Hi" },
  image,
});
const slide = (image: string) => ({
  title: { ar: "", en: "Welcome" },
  subtitle: { ar: "", en: "" },
  action: { type: "none" },
  image,
});
const vote = (image: string) => ({
  options: [
    { id: "a", text: { en: "Robots" }, image },
    { id: "b", text: { en: "Space" } },
  ],
});
const game = (images: object) => ({ game: "slide_puzzle", level: "easy", attempts: 3, images });

/**
 * Organizer images over HTTP on the S3 double (ADR-829): the team's upload door, the two read doors (a 302 to a 5-minute
 * signed URL on the bucket's host, every refusal one 404), idempotent repeats, photos off, and each holder: a branding,
 * layout, map, sponsor, game or vote that names another event's image is refused with 422, and one that names its own is
 * drawn by the player through the event's door.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("organizer images over HTTP", () => {
  let db: TestDatabase;
  let fake: FakeS3;
  let test: TestApp;
  let off: TestApp;
  let orgA = "";
  let orgB = "";
  let ownerA = "";
  let ownerB = "";
  let scoped = "";
  let offCookie = "";
  let counter = 0;
  let png: Buffer;
  let jpeg: Buffer;
  let scopedEvent = "";

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []) =>
    (await owner<{ id: string }>(sql, values))[0]?.id ?? "";

  beforeAll(async () => {
    db = await createTestDatabase();
    fake = await startFakeS3();
    const storage = createObjectStore(fake.settings, { retryDelayMs: 1 });
    test = await startApp(db, false, {}, { storage });
    off = await startApp(db);
    orgA = await one("INSERT INTO organizer (name, slug) VALUES ('img-a', 'img-a') RETURNING id");
    orgB = await one("INSERT INTO organizer (name, slug) VALUES ('img-b', 'img-b') RETURNING id");
    scopedEvent = await newEvent(orgA);
    const member = async (org: string, email: string, role: string, scope: string[] | null) => {
      const id = await createStaff(db.owner, { email });
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
        [org, id, role, scope],
      );
    };
    await member(orgA, "owner@img-a.test", "owner", null);
    await member(orgB, "owner@img-b.test", "owner", null);
    await member(orgA, "editor@img-a.test", "editor", [scopedEvent]);
    ownerA = await signInFully(test, "owner@img-a.test");
    ownerB = await signInFully(test, "owner@img-b.test");
    scoped = await signInFully(test, "editor@img-a.test");
    offCookie = await signInFully(off, "owner@img-a.test");
    png = await sharp({
      create: { width: 900, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#2a6" } })
      .withExif({ IFD0: { Make: "QuestifyCam" } })
      .jpeg()
      .toBuffer();
  });
  afterAll(async () => {
    await test.close();
    await off.close();
    await fake.close();
    await db.close();
  });

  async function newEvent(org: string): Promise<string> {
    counter += 1;
    const event = await one(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Image Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [org, `IMGH${counter}`],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event]);
    return event;
  }
  const newPlayer = async (org: string, event: string) => {
    counter += 1;
    const id = await one("INSERT INTO player (username) VALUES ($1) RETURNING id", [
      `image_http_${counter}`,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      org,
      event,
      id,
    ]);
    return token;
  };
  const team = (
    method: "GET" | "POST" | "PUT" | "PATCH",
    org: string,
    path: string,
    payload?: object,
    cookie = ownerA,
    on: TestApp = test,
  ): Promise<Reply> =>
    on.app.inject({
      method,
      url: `/v1/organizers/${org}${path}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const upload = (
    org: string,
    event: string,
    purpose: string,
    body: Buffer = jpeg,
    options: { cookie?: string; key?: string; on?: TestApp; type?: string } = {},
  ): Promise<Reply> =>
    (options.on ?? test).app.inject({
      method: "POST",
      url: `/v1/organizers/${org}/events/${event}/images?purpose=${purpose}`,
      headers: withSession(options.cookie ?? ownerA, {
        "idempotency-key": options.key ?? randomUUID(),
        "content-type": options.type ?? "image/jpeg",
      }),
      payload: body,
    });
  const imageOf = async (org: string, event: string, purpose: string, cookie = ownerA) => {
    const sent = await upload(
      org,
      event,
      purpose,
      purpose === "logo" || purpose === "icon" ? png : jpeg,
      {
        cookie,
        type: purpose === "logo" || purpose === "icon" ? "image/png" : "image/jpeg",
      },
    );
    expect(sent.statusCode).toBe(201);
    return sent.json<{ imageId: string; width: number; height: number }>().imageId;
  };
  const playerRead = (event: string, image: string, token: string, on: TestApp = test) =>
    on.app.inject({
      method: "GET",
      url: `/v1/events/${event}/images/${image}`,
      headers: { authorization: `Bearer ${token}` },
    });
  const teamRead = (org: string, event: string, image: string, cookie = ownerA) =>
    test.app.inject({
      method: "GET",
      url: `/v1/organizers/${org}/events/${event}/images/${image}`,
      headers: withSession(cookie),
    });

  describe("the upload and the read doors", () => {
    it("stores a logo as a PNG under the event's prefix and redirects a member to a 5-minute URL", async () => {
      const event = await newEvent(orgA);
      const sent = await upload(orgA, event, "logo", png, { type: "image/png" });
      expect(sent.statusCode).toBe(201);
      const stored = sent.json<{ imageId: string; width: number; height: number }>();
      expect([stored.width, stored.height]).toEqual([512, 171]);
      const key = `o/${orgA}/e/${event}/logo/${stored.imageId}.png`;
      expect(fake.objects.get(key)?.contentType).toBe("image/png");
      expect((await sharp(fake.objects.get(key)?.body).metadata()).hasAlpha).toBe(true);

      const token = await newPlayer(orgA, event);
      const read = await playerRead(event, stored.imageId, token);
      expect(read.statusCode).toBe(302);
      expect(read.headers["cache-control"]).toBe("private, max-age=240");
      expect(read.headers["referrer-policy"]).toBe("no-referrer");
      const url = new URL(String(read.headers["location"]));
      expect(url.origin).toBe(fake.settings.endpoint);
      expect(url.pathname).toBe(`/${fake.settings.bucket}/${key}`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
      expect(url.searchParams.get("response-content-type")).toBe("image/png");
      const fetched = await fetch(url);
      expect([fetched.status, fetched.headers.get("content-type")]).toEqual([200, "image/png"]);

      // The app's client asks for JSON: the same signed URL, so no redirect carries its token to the bucket.
      const asJson = await test.app.inject({
        method: "GET",
        url: `/v1/events/${event}/images/${stored.imageId}`,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      expect(asJson.statusCode).toBe(200);
      const answer = asJson.json<{ url: string; expiresAt: string }>();
      expect(new URL(answer.url).pathname).toBe(`/${fake.settings.bucket}/${key}`);
      const left = new Date(answer.expiresAt).getTime() - Date.now();
      expect(left).toBeGreaterThan(280_000);
      expect(left).toBeLessThanOrEqual(300_000);
      const preview = await teamRead(orgA, event, stored.imageId);
      expect(preview.statusCode).toBe(302);
      expect(new URL(String(preview.headers["location"])).pathname).toBe(
        `/${fake.settings.bucket}/${key}`,
      );
    });

    it("stores one object for a repeated key, strips EXIF and refuses what is no image", async () => {
      const event = await newEvent(orgA);
      const key = randomUUID();
      const first = await upload(orgA, event, "picture", jpeg, { key });
      const again = await upload(orgA, event, "picture", jpeg, { key });
      expect(again.json()).toEqual(first.json());
      const id = first.json<{ imageId: string }>().imageId;
      const stored = fake.objects.get(`o/${orgA}/e/${event}/picture/${id}.jpg`);
      expect((await sharp(stored?.body).metadata()).exif).toBeUndefined();
      expect(codeOf(await upload(orgA, event, "picture", Buffer.from("GIF89a....")))).toEqual([
        415,
        "photo_type",
      ]);
      expect(codeOf(await upload(orgA, event, "sticker", jpeg))).toEqual([400, "invalid_request"]);
    });

    it("answers 503 for an upload and 404 for a read on a server with no bucket", async () => {
      const event = await newEvent(orgA);
      const image = await imageOf(orgA, event, "banner");
      expect(
        codeOf(await upload(orgA, event, "banner", jpeg, { cookie: offCookie, on: off })),
      ).toEqual([503, "photos_off"]);
      const token = await newPlayer(orgA, event);
      expect((await playerRead(event, image, token, off)).statusCode).toBe(404);
      const view = await team("GET", orgA, `/events/${event}`, undefined, offCookie, off);
      expect(view.json<{ event: { photos: boolean } }>().event.photos).toBe(false);
      const on = await team("GET", orgA, `/events/${event}`);
      expect(on.json<{ event: { photos: boolean } }>().event.photos).toBe(true);
    });

    it("answers one 404 to another organizer, an editor outside their scope and a player of another event", async () => {
      const event = await newEvent(orgA);
      const sibling = await newEvent(orgA);
      const image = await imageOf(orgA, event, "picture");
      const theirs = await imageOf(orgA, sibling, "picture");
      expect((await teamRead(orgA, event, image, ownerB)).statusCode).toBe(404);
      expect((await teamRead(orgB, event, image, ownerB)).statusCode).toBe(404);
      expect((await teamRead(orgA, event, image, scoped)).statusCode).toBe(404);
      expect((await teamRead(orgA, scopedEvent, image, scoped)).statusCode).toBe(404);
      expect(codeOf(await upload(orgA, event, "picture", jpeg, { cookie: scoped }))[0]).toBe(404);
      expect(codeOf(await upload(orgA, event, "picture", jpeg, { cookie: ownerB }))[0]).toBe(404);
      const token = await newPlayer(orgA, event);
      expect((await playerRead(event, theirs, token)).statusCode).toBe(404);
      expect((await playerRead(sibling, theirs, token)).statusCode).toBe(404);
      expect((await playerRead(event, randomUUID(), token)).statusCode).toBe(404);
      expect((await playerRead(event, "not-an-id", token)).statusCode).toBe(404);
      const stranger = await newPlayer(orgB, await newEvent(orgB));
      expect((await playerRead(event, image, stranger)).statusCode).toBe(404);
    });
  });

  describe("the holders", () => {
    it("saves a branding logo and banner of the event, and refuses another event's or another organizer's", async () => {
      const event = await newEvent(orgA);
      const logo = await imageOf(orgA, event, "logo");
      const banner = await imageOf(orgA, event, "banner");
      const sibling = await imageOf(orgA, await newEvent(orgA), "logo");
      const foreign = await imageOf(orgB, await newEvent(orgB), "logo", ownerB);
      const save = (body: object) => team("PUT", orgA, `/events/${event}/branding`, body);
      expect((await save({ accent: null, logo, banner })).statusCode).toBe(200);
      const view = await team("GET", orgA, `/events/${event}`);
      expect(view.json<{ event: Row }>().event["branding"]).toEqual({ accent: null, logo, banner });
      for (const id of [sibling, foreign]) {
        const refused = await save({ accent: null, logo: id });
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({ code: "image_unknown", details: { field: "logo" } });
      }
      expect(codeOf(await save({ accent: null, logo: banner }))).toEqual([422, "image_unknown"]);
      const token = await newPlayer(orgA, event);
      const config = await test.app.inject({
        method: "GET",
        url: `/v1/config?event=${event}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(config.json<{ branding: Row }>().branding).toEqual({ accent: null, logo, banner });
      expect((await playerRead(event, logo, token)).statusCode).toBe(302);
    });

    it("saves layout images of the event and refuses another event's or organizer's with the field", async () => {
      const event = await newEvent(orgA);
      const banner = await imageOf(orgA, event, "banner");
      const picture = await imageOf(orgA, event, "picture");
      const sibling = await imageOf(orgA, await newEvent(orgA), "banner");
      const foreign = await imageOf(orgB, await newEvent(orgB), "banner", ownerB);
      const save = (content: object) =>
        team("PUT", orgA, `/events/${event}/layout`, layoutWith(content));
      const good = await save({
        banner: [slide(banner)],
        cards: [card(picture)],
        page: {
          title: { ar: "", en: "Venue" },
          blocks: [{ kind: "image", image: picture, alt: { ar: "", en: "The hall" } }],
        },
      });
      expect(good.statusCode).toBe(200);
      for (const id of [sibling, foreign]) {
        const refused = await save({ banner: [slide(id)], cards: [card(picture)] });
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          code: "image_unknown",
          details: { field: "content.banner.0.image" },
        });
      }
      expect(codeOf(await save({ banner: [slide(picture)], cards: [card(picture)] }))).toEqual([
        422,
        "image_unknown",
      ]);
    });

    it("saves a map's picture and a sponsor's logo of the event, and refuses another event's", async () => {
      const event = await newEvent(orgA);
      const board = await imageOf(orgA, event, "map");
      const logo = await imageOf(orgA, event, "logo");
      const siblingMap = await imageOf(orgA, await newEvent(orgA), "map");
      const siblingLogo = await imageOf(orgA, await newEvent(orgA), "logo");
      const foreign = await imageOf(orgB, await newEvent(orgB), "map", ownerB);
      const foreignLogo = await imageOf(orgB, await newEvent(orgB), "logo", ownerB);
      const map = await team("POST", orgA, `/events/${event}/maps`, {
        nameEn: "Hall",
        image: board,
      });
      expect(map.json<{ image: Row }>().image).toEqual({ id: board, width: 800, height: 600 });
      for (const id of [siblingMap, foreign]) {
        const refusedMap = await team("POST", orgA, `/events/${event}/maps`, {
          nameEn: "Hall",
          image: id,
        });
        expect(refusedMap.statusCode).toBe(422);
        expect(refusedMap.json()).toMatchObject({
          code: "image_unknown",
          details: { field: "image" },
        });
      }
      const sponsor = await team("POST", orgA, `/events/${event}/sponsors`, {
        nameEn: "Acme",
        tier: "gold",
        logo,
      });
      expect(sponsor.json<Row>()["logo"]).toBe(logo);
      for (const id of [siblingLogo, foreignLogo]) {
        expect(
          codeOf(
            await team("POST", orgA, `/events/${event}/sponsors`, {
              nameEn: "Acme",
              tier: "gold",
              logo: id,
            }),
          ),
        ).toEqual([422, "image_unknown"]);
      }
      await owner(
        "UPDATE event SET config = jsonb_set(config, '{features}', '{\"maps\": true}') WHERE id = $1",
        [event],
      );
      const token = await newPlayer(orgA, event);
      const sponsors = await test.app.inject({
        method: "GET",
        url: `/v1/events/${event}/sponsors`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(sponsors.json<{ sponsors: Row[] }>().sponsors[0]).toMatchObject({ logo });
    });

    it("saves vote option icons and game art of the event, refuses another event's or organizer's, and shows them to the player", async () => {
      const event = await newEvent(orgA);
      const [category] = await owner<{ id: string }>(
        "SELECT id FROM category WHERE event_id = $1",
        [event],
      );
      const icon = await imageOf(orgA, event, "icon");
      const picture = await imageOf(orgA, event, "picture");
      const sibling = await imageOf(orgA, await newEvent(orgA), "icon");
      const foreign = await imageOf(orgB, await newEvent(orgB), "icon", ownerB);
      const siblingPicture = await imageOf(orgA, await newEvent(orgA), "picture");
      const foreignPicture = await imageOf(orgB, await newEvent(orgB), "picture", ownerB);
      const create = (type: string, config: object) =>
        team("POST", orgA, `/events/${event}/quests`, {
          categoryId: category?.id,
          type,
          title: { en: "Play" },
          points: 10,
          visible: true,
          config,
        });
      const made = await create("vote", vote(icon));
      expect(made.statusCode).toBe(201);
      for (const id of [sibling, foreign]) {
        const refused = await create("vote", vote(id));
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          code: "image_unknown",
          details: { field: "config.options.0.image" },
        });
      }
      expect((await create("game", game({ picture }))).statusCode).toBe(201);
      for (const id of [siblingPicture, foreignPicture]) {
        const refusedGame = await create("game", game({ picture: id }));
        expect(refusedGame.statusCode).toBe(422);
        expect(refusedGame.json()).toMatchObject({
          code: "image_unknown",
          details: { field: "config.images.picture" },
        });
      }
      expect(codeOf(await create("game", game({ picture: icon })))).toEqual([422, "image_unknown"]);
      expect(codeOf(await create("game", game({ faces: [icon] })))).toEqual([422, "invalid_quest"]);

      const token = await newPlayer(orgA, event);
      const quest = made.json<{ quest: { id: string } }>().quest.id;
      const read = await test.app.inject({
        method: "GET",
        url: `/v1/quests/${quest}/vote`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(read.json<{ options: Row[] }>().options).toEqual([
        { id: "a", text: { ar: null, en: "Robots" }, image: icon },
        { id: "b", text: { ar: null, en: "Space" } },
      ]);
    });

    it("refuses another event's or organizer's image on a quest edit, and on a change set's apply", async () => {
      const event = await newEvent(orgA);
      const [category] = await owner<{ id: string }>(
        "SELECT id FROM category WHERE event_id = $1",
        [event],
      );
      const icon = await imageOf(orgA, event, "icon");
      const sibling = await imageOf(orgA, await newEvent(orgA), "icon");
      const foreign = await imageOf(orgB, await newEvent(orgB), "icon", ownerB);
      const made = await team("POST", orgA, `/events/${event}/quests`, {
        categoryId: category?.id,
        type: "vote",
        title: { en: "Pick" },
        points: 10,
        visible: true,
        config: vote(icon),
      });
      expect(made.statusCode).toBe(201);
      const quest = made.json<{ quest: { id: string } }>().quest.id;
      const stored = async () =>
        (await owner("SELECT type_config FROM quest WHERE id = $1", [quest]))[0]?.["type_config"];
      const before = await stored();

      for (const id of [sibling, foreign]) {
        const patched = await team("PATCH", orgA, `/events/${event}/quests/${quest}`, {
          config: vote(id),
          confirm: true,
        });
        expect(patched.statusCode).toBe(422);
        expect(patched.json()).toMatchObject({
          code: "image_unknown",
          details: { field: "config.options.0.image" },
        });
      }
      expect(await stored()).toEqual(before);

      const set = await team("POST", orgA, `/events/${event}/change-sets`, {
        items: [sibling, foreign].map((id) => ({
          op: "edit",
          target: "quest",
          targetId: quest,
          body: { config: vote(id) },
        })),
      });
      expect(set.statusCode).toBe(201);
      const setId = set.json<{ changeSet: { id: string } }>().changeSet.id;
      const opened = await team("GET", orgA, `/events/${event}/change-sets/${setId}`);
      const items = opened.json<{ changeSet: { items: { id: string }[] } }>().changeSet.items;
      const applied = await team("POST", orgA, `/events/${event}/change-sets/${setId}/apply`, {
        itemIds: items.map((item) => item.id),
      });
      expect(applied.statusCode).toBe(200);
      const failed = {
        status: "failed",
        error: { code: "image_unknown", details: { field: "config.options.0.image" } },
      };
      expect(applied.json<{ results: Row[] }>().results).toMatchObject([failed, failed]);
      expect(await stored()).toEqual(before);
    });
  });
});
