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

const SYSTEM: RequestContext = {};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const plain = pg.detail !== undefined && /^[\w.]+$/.test(pg.detail);
    return plain ? `${pg.code}:${pg.detail}` : `${pg.code}`;
  }
};

/**
 * Organizer images in the database (migration 0194): the key and uploader shapes, the team's upload slots and their caps,
 * naming an image from a save (another event's id refused), the two read doors' seats, the sweep that deletes what nothing
 * names (and keeps what a save in flight holds), the map and sponsor columns' foreign keys, and the duplicate's strip.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("organizer images (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
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

  const newEvent = async (org = ids.orgA, status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Image Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [org, `IMGS${counter}`, status],
    );
    return event?.id ?? "";
  };
  const member = async (event: string, org = ids.orgA) => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`image_player_${counter}`],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      org,
      event,
      made?.id,
    ]);
    return made?.id ?? "";
  };
  const reserve = async (
    event: string,
    kind = "picture",
    context = teamA(),
    key: string = randomUUID(),
  ) =>
    (
      await query<Slot>(context, "SELECT * FROM media_image_reserve($1, $2, $3)", [
        event,
        kind,
        key,
      ])
    )[0] as Slot;
  const store = async (slot: Slot, context = teamA()) =>
    (
      await query<{ ok: boolean }>(
        context,
        "SELECT media_image_stored($1, $2, 1000, 640, 480) AS ok",
        [slot.id, slot.key],
      )
    )[0]?.ok;
  const image = async (event: string, kind = "picture", context = teamA()) => {
    const slot = await reserve(event, kind, context);
    await store(slot, context);
    return slot;
  };
  const use = (event: string, imageId: string, kind = "picture", context = teamA()) =>
    query(context, "SELECT media_images_use($1, $2::uuid[], $3::text[], $4::text[])", [
      event,
      [imageId],
      [kind],
      ["branding.logo"],
    ]);
  const exists = async (id: string) =>
    (await owner("SELECT 1 FROM media_object WHERE id = $1", [id])).length === 1;
  const age = (id: string, hours = 25) =>
    owner(
      `UPDATE media_object SET stored_at = now() - make_interval(hours => $2),
         used_at = CASE WHEN used_at IS NULL THEN NULL ELSE now() - make_interval(hours => $2) END
       WHERE id = $1`,
      [id, hours],
    );
  const sweep = async () =>
    Number((await query<{ n: number }>(SYSTEM, "SELECT media_sweep_images(500) AS n"))[0]?.n ?? 0);

  describe("the rows", () => {
    it("keys a logo as a PNG and a picture as a JPEG under the event's own prefix", async () => {
      const event = await newEvent();
      const logo = await reserve(event, "logo");
      const picture = await reserve(event, "picture");
      expect(logo.key).toBe(`o/${ids.orgA}/e/${event}/logo/${logo.id}.png`);
      expect(picture.key).toBe(`o/${ids.orgA}/e/${event}/picture/${picture.id}.jpg`);
      const [row] = await owner<{ format: string; staff: string; player: string | null }>(
        "SELECT format, uploaded_by_staff AS staff, uploaded_by_player AS player FROM media_object WHERE id = $1",
        [logo.id],
      );
      expect(row).toEqual({ format: "png", staff: ownerA, player: null });
    });

    it("refuses a key with the other format, a player on an organizer image, and an image of no uploader kind", async () => {
      const event = await newEvent();
      const id = randomUUID();
      const insert = (purpose: string, format: string, ext: string, player: string | null) =>
        owner(
          `INSERT INTO media_object (id, organizer_id, event_id, purpose, format, key, uploaded_by_player,
                                     uploaded_by_staff, request_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'k')`,
          [
            id,
            ids.orgA,
            event,
            purpose,
            format,
            `o/${ids.orgA}/e/${event}/${purpose}/${id}${ext}`,
            player,
            player === null ? ownerA : null,
          ],
        );
      expect(await refusal(insert("logo", "png", ".jpg", null))).toBe("23514");
      expect(await refusal(insert("logo", "jpeg", ".jpg", null))).toBe("23514");
      expect(await refusal(insert("logo", "png", ".png", ids.playerA))).toBe("23514");
      expect(await refusal(insert("submission", "jpeg", ".jpg", null))).toBe("23514");
      expect(await refusal(insert("logo", "png", ".png", null))).toBe("none");
    });
  });

  describe("the upload doors", () => {
    it("answers the same slot for the same key, and refuses the key for another kind", async () => {
      const event = await newEvent();
      const key = randomUUID();
      const first = await reserve(event, "banner", teamA(), key);
      expect(await reserve(event, "banner", teamA(), key)).toEqual(first);
      expect(await refusal(reserve(event, "map", teamA(), key))).toBe("QK422");
      expect(await store(first)).toBe(true);
      expect(await reserve(event, "banner", teamA(), key)).toMatchObject({
        id: first.id,
        stored: true,
        width: 640,
      });
    });

    it("refuses another organizer's event, an event outside the editor's scope, a player and a device", async () => {
      const event = await newEvent();
      const other = await newEvent();
      expect(await refusal(reserve(event, "picture", teamB()))).toBe("AN404");
      const scoped = await addMember(db.owner, ids.orgA, "editor", [other]);
      const editor = { organizerId: ids.orgA, staffUserId: scoped };
      expect(await refusal(reserve(event, "picture", editor))).toBe("AN404");
      expect((await reserve(other, "picture", editor)).id).toMatch(/[0-9a-f-]{36}/);
      expect(await refusal(reserve(event, "picture", { playerId: ids.playerA }))).toBe("42501");
      expect(await refusal(reserve(event, "submission"))).toBe("MD422");
    });

    it("refuses an archived or suspended event", async () => {
      const archived = await newEvent(ids.orgA, "archived");
      expect(await refusal(reserve(archived))).toBe("MI409:event_closed");
      const suspended = await newEvent();
      await owner(
        "UPDATE event SET suspended_at = now(), suspension_reason = 'a test of the image doors' WHERE id = $1",
        [suspended],
      );
      expect(await refusal(reserve(suspended))).toBe("MI409:event_closed");
    });

    it("caps a staff member at 30 uploads in 10 minutes", async () => {
      const staff = await addMember(db.owner, ids.orgA, "editor");
      const context = { organizerId: ids.orgA, staffUserId: staff };
      const event = await newEvent();
      for (let i = 0; i < 30; i += 1) await reserve(event, "icon", context);
      expect(await refusal(reserve(event, "icon", context))).toMatch(/^MD429:\d+$/);
    });

    it("caps an event at 200 images no save has named", async () => {
      const event = await newEvent();
      const slot = await reserve(event);
      await owner(
        `INSERT INTO media_object (id, organizer_id, event_id, purpose, key, uploaded_by_staff, request_key, created_at)
         SELECT g, $1::uuid, $2::uuid, 'picture', 'o/' || $1 || '/e/' || $2 || '/picture/' || g || '.jpg', NULL,
                'k' || g,
                now() - interval '1 hour'
         FROM (SELECT gen_random_uuid() AS g FROM generate_series(1, 199)) s`,
        [ids.orgA, event],
      );
      expect(await refusal(reserve(event))).toBe("MD429:3600");
      await owner("UPDATE media_object SET used_at = now() WHERE id = $1", [slot.id]);
      expect((await reserve(event)).id).toMatch(/[0-9a-f-]{36}/);
      await owner("DELETE FROM media_object WHERE event_id = $1", [event]);
    });

    it("stores and releases only the caller's own slot", async () => {
      const event = await newEvent();
      const slot = await reserve(event);
      const other = {
        organizerId: ids.orgA,
        staffUserId: await addMember(db.owner, ids.orgA, "editor"),
      };
      expect(await refusal(store(slot, other))).toBe("SM404");
      expect(await refusal(store(slot, { playerId: ids.playerA }))).toBe("42501");
      expect(await query(other, "SELECT media_image_release($1) AS ok", [slot.id])).toEqual([
        { ok: false },
      ]);
      expect(await query(teamA(), "SELECT media_image_release($1) AS ok", [slot.id])).toEqual([
        { ok: true },
      ]);
      expect(await exists(slot.id)).toBe(false);
    });

    it("keeps the player doors closed to an organizer image (no null owner slips through)", async () => {
      const event = await newEvent();
      const slot = await reserve(event);
      expect(
        await refusal(
          query({ playerId: ids.playerA }, "SELECT media_stored($1, $2, 1, 1, 1)", [
            slot.id,
            slot.key,
          ]),
        ),
      ).toBe("SM404");
      expect(
        await query({ playerId: ids.playerA }, "SELECT media_release($1) AS ok", [slot.id]),
      ).toEqual([{ ok: false }]);
    });
  });

  describe("naming an image", () => {
    it("marks a stored image of the event used and refuses any other id with the field", async () => {
      const event = await newEvent();
      const sibling = await newEvent();
      const mine = await image(event);
      const theirs = await image(sibling);
      const foreign = await image(ids.eventB, "picture", teamB());
      const unstored = await reserve(event);
      await use(event, mine.id);
      expect(
        (
          await owner<{ used: boolean }>(
            "SELECT used_at IS NOT NULL AS used FROM media_object WHERE id = $1",
            [mine.id],
          )
        )[0],
      ).toEqual({ used: true });
      expect(await refusal(use(event, theirs.id))).toBe("MI422:branding.logo");
      expect(await refusal(use(event, foreign.id))).toBe("MI422:branding.logo");
      expect(await refusal(use(event, unstored.id))).toBe("MI422:branding.logo");
      expect(await refusal(use(event, mine.id, "logo"))).toBe("MI422:branding.logo");
      expect(await refusal(use(event, randomUUID()))).toBe("MI422:branding.logo");
      expect(await refusal(use(ids.eventB, foreign.id))).toBe("AN404");
    });

    it("refuses a map or sponsor naming another event's image, through the door and the foreign key", async () => {
      const event = await newEvent();
      const sibling = await newEvent();
      const theirs = await image(sibling, "map");
      const foreign = await image(ids.eventB, "logo", teamB());
      const saveMap = (pic: string) =>
        query(teamA(), "SELECT map_save($1, $2::jsonb, NULL, $3) AS map", [
          event,
          JSON.stringify({ nameEn: "Hall", image: pic }),
          randomUUID(),
        ]);
      expect(await refusal(saveMap(theirs.id))).toBe("MI422:image");
      const saveSponsor = (logo: string) =>
        query(teamA(), "SELECT sponsor_save($1, $2::jsonb, NULL, $3) AS s", [
          event,
          JSON.stringify({ nameEn: "Acme", tier: "gold", logo }),
          randomUUID(),
        ]);
      expect(await refusal(saveSponsor(foreign.id))).toBe("MI422:logo");
      expect(
        await refusal(
          owner(
            `INSERT INTO event_map (organizer_id, event_id, name_en, position, created_by, image)
             VALUES ($1, $2, 'Hall', 1, $3, $4)`,
            [ids.orgA, event, ownerA, theirs.id],
          ),
        ),
      ).toBe("23503");
      expect(
        await refusal(
          owner(
            `INSERT INTO sponsor (organizer_id, event_id, name_en, tier, created_by, logo)
             VALUES ($1, $2, 'Acme', 'gold', $3, $4)`,
            [ids.orgA, event, ownerA, foreign.id],
          ),
        ),
      ).toBe("23503");
    });

    it("saves, keeps and clears a map's picture and a sponsor's logo", async () => {
      const event = await newEvent();
      const pic = await image(event, "map");
      const [made] = await query<{ map: { id: string; image: unknown } }>(
        teamA(),
        "SELECT map_save($1, $2::jsonb, NULL, $3) AS map",
        [event, JSON.stringify({ nameEn: "Hall", image: pic.id }), randomUUID()],
      );
      expect(made?.map.image).toEqual({ id: pic.id, width: 640, height: 480 });
      const [kept] = await query<{ map: { image: unknown } }>(
        teamA(),
        "SELECT map_save($1, $2::jsonb, $3, $4) AS map",
        [event, JSON.stringify({ nameEn: "Hall 2" }), made?.map.id, randomUUID()],
      );
      expect(kept?.map.image).toEqual({ id: pic.id, width: 640, height: 480 });
      const [cleared] = await query<{ map: { image: unknown } }>(
        teamA(),
        "SELECT map_save($1, $2::jsonb, $3, $4) AS map",
        [event, JSON.stringify({ nameEn: "Hall 2", image: null }), made?.map.id, randomUUID()],
      );
      expect(cleared?.map.image).toBeNull();
      const logo = await image(event, "logo");
      const [sponsor] = await query<{ s: { logo: string; banner: null } }>(
        teamA(),
        "SELECT sponsor_save($1, $2::jsonb, NULL, $3) AS s",
        [event, JSON.stringify({ nameEn: "Acme", tier: "gold", logo: logo.id }), randomUUID()],
      );
      expect(sponsor?.s).toMatchObject({ logo: logo.id, banner: null });
    });
  });

  describe("the read doors", () => {
    it("gives an active member the key of their event's stored image only", async () => {
      const event = await newEvent();
      const sibling = await newEvent();
      const player = await member(event);
      const mine = await image(event, "logo");
      const theirs = await image(sibling);
      const read = (path: string, id: string, who = player) =>
        query<{ key: string | null }>({ playerId: who }, "SELECT event_image_key($1, $2) AS key", [
          path,
          id,
        ]);
      expect(await read(event, mine.id)).toEqual([{ key: mine.key }]);
      expect(await read(event, theirs.id)).toEqual([{ key: null }]);
      expect(await refusal(read(sibling, theirs.id))).toBe("AM403");
      expect(await read(event, (await reserve(event)).id)).toEqual([{ key: null }]);
      await owner(
        "UPDATE event SET suspended_at = now(), suspension_reason = 'a test of the image doors' WHERE id = $1",
        [event],
      );
      expect(await read(event, mine.id)).toEqual([{ key: null }]);
    });

    it("never gives a player photo's key through the image door", async () => {
      const event = await newEvent();
      const player = await member(event);
      const photo = randomUUID();
      await owner(
        `INSERT INTO media_object (id, organizer_id, event_id, purpose, key, uploaded_by_player, request_key, state,
                                   bytes, width, height, stored_at)
         VALUES ($1, $2, $3, 'ticket', $4, $5, 'k', 'stored', 1, 1, 1, now())`,
        [photo, ids.orgA, event, `o/${ids.orgA}/e/${event}/ticket/${photo}.jpg`, player],
      );
      expect(
        await query({ playerId: player }, "SELECT event_image_key($1, $2) AS key", [event, photo]),
      ).toEqual([{ key: null }]);
      expect(await query(teamA(), "SELECT team_image_key($1, $2) AS key", [event, photo])).toEqual([
        { key: null },
      ]);
    });

    it("gives the team the key inside its organizer and event scope only", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const mine = await image(event);
      const read = (context: RequestContext, path = event) =>
        query(context, "SELECT team_image_key($1, $2) AS key", [path, mine.id]);
      expect(await read(teamA())).toEqual([{ key: mine.key }]);
      expect(await refusal(read(teamB()))).toBe("AN404");
      const scoped = await addMember(db.owner, ids.orgA, "editor", [other]);
      const editor = { organizerId: ids.orgA, staffUserId: scoped };
      expect(await refusal(read(editor))).toBe("AN404");
      expect(await read(editor, other)).toEqual([{ key: null }]);
      expect(await refusal(read({ playerId: ids.playerA }))).toBe("AN404");
    });
  });

  describe("the sweep", () => {
    it("keeps an image named by the config, a quest, a pending change set or a column, and deletes the rest", async () => {
      const event = await newEvent();
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
        [event],
      );
      const inConfig = await image(event, "logo");
      const inQuest = await image(event, "icon");
      const inChange = await image(event);
      const inMap = await image(event, "map");
      const loose = await image(event);
      const recent = await image(event);
      await owner(
        "UPDATE event SET config = jsonb_set(config, '{branding}', $2::jsonb) WHERE id = $1",
        [event, JSON.stringify({ accent: null, logo: inConfig.id.toUpperCase() })],
      );
      await owner(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'game', 'Match', 10, $3)`,
        [
          event,
          category?.id,
          JSON.stringify({
            game: "memory_match",
            level: "easy",
            attempts: 3,
            cooldownMinutes: null,
            images: { faces: [inQuest.id] },
          }),
        ],
      );
      const [set] = await owner<{ id: string }>(
        "INSERT INTO change_set (organizer_id, event_id, created_by) VALUES ($1, $2, $3) RETURNING id",
        [ids.orgA, event, ownerA],
      );
      await owner(
        `INSERT INTO change_set_item (change_set_id, organizer_id, event_id, position, op, target, body)
         VALUES ($1, $2, $3, 0, 'add', 'quest', $4)`,
        [
          set?.id,
          ids.orgA,
          event,
          JSON.stringify({ config: { images: { picture: inChange.id } } }),
        ],
      );
      await owner(
        `INSERT INTO event_map (organizer_id, event_id, name_en, position, created_by, image)
         VALUES ($1, $2, 'Hall', 1, $3, $4)`,
        [ids.orgA, event, ownerA, inMap.id],
      );
      for (const slot of [inConfig, inQuest, inChange, inMap, loose]) await age(slot.id);
      await age(recent.id, 23);
      expect(await sweep()).toBe(1);
      expect(await exists(loose.id)).toBe(false);
      for (const slot of [inConfig, inQuest, inChange, inMap, recent]) {
        expect(await exists(slot.id)).toBe(true);
      }
      expect(
        (
          await owner<{ n: string }>("SELECT count(*) AS n FROM media_delete WHERE key = $1", [
            loose.key,
          ])
        )[0]?.n,
      ).toBe("1");
      await owner("UPDATE change_set SET status = 'closed', finished_at = now() WHERE id = $1", [
        set?.id,
      ]);
      await age(inChange.id);
      expect(await sweep()).toBe(1);
      expect(await exists(inChange.id)).toBe(false);
    });

    it("deletes an image 24 hours after a save stopped naming it", async () => {
      const event = await newEvent();
      const logo = await image(event, "logo");
      await use(event, logo.id, "logo");
      await owner(
        "UPDATE event SET config = jsonb_set(config, '{branding}', $2::jsonb) WHERE id = $1",
        [event, JSON.stringify({ accent: null, logo: logo.id })],
      );
      await age(logo.id);
      expect(await sweep()).toBe(0);
      const [row] = await owner<{ fresh: boolean }>(
        "SELECT used_at > now() - interval '1 minute' AS fresh FROM media_object WHERE id = $1",
        [logo.id],
      );
      expect(row?.fresh).toBe(true);
      await owner("UPDATE event SET config = config #- '{branding,logo}' WHERE id = $1", [event]);
      await age(logo.id);
      expect(await sweep()).toBe(1);
    });

    it("deletes an organizer slot never stored after 30 minutes, and leaves player photos to their own sweep", async () => {
      const event = await newEvent();
      const slot = await reserve(event);
      await owner(
        "UPDATE media_object SET created_at = now() - interval '31 minutes' WHERE id = $1",
        [slot.id],
      );
      const stored = await image(event);
      await owner(
        "UPDATE media_object SET created_at = now() - interval '31 minutes' WHERE id = $1",
        [stored.id],
      );
      await query(SYSTEM, "SELECT media_sweep_uploads()");
      expect(await exists(stored.id)).toBe(true);
      expect(await exists(slot.id)).toBe(true);
      expect(await sweep()).toBe(1);
      expect(await exists(slot.id)).toBe(false);
    });

    it("skips an image a save in flight is naming (SKIP LOCKED), and refuses a save that names a swept one after the sweep committed", async () => {
      const event = await newEvent();
      const held = await image(event);
      const gone = await image(event);
      await age(held.id);
      await age(gone.id);
      const saving = await pool.connect();
      let swept = -1;
      try {
        await withRequestContext(saving, teamA(), async () => {
          await saving.query("SELECT media_images_use($1, $2::uuid[], '{picture}', '{card}')", [
            event,
            [held.id],
          ]);
          swept = await sweep();
        });
      } finally {
        saving.release();
      }
      expect(swept).toBe(1);
      expect(await exists(held.id)).toBe(true);
      expect(await exists(gone.id)).toBe(false);
      expect(await refusal(use(event, gone.id))).toBe("MI422:branding.logo");
    });

    it("refuses every image door but the sweep to any seat but the system's", async () => {
      expect(await refusal(query(teamA(), "SELECT media_sweep_images(1)"))).toBe("42501");
      expect(await refusal(query({ playerId: ids.playerA }, "SELECT media_sweep_images(1)"))).toBe(
        "42501",
      );
    });
  });

  describe("deleting and copying", () => {
    it("clears a map's picture and a sponsor's logo when the image row goes (the purge)", async () => {
      const event = await newEvent();
      const pic = await image(event, "map");
      const logo = await image(event, "logo");
      await query(teamA(), "SELECT map_save($1, $2::jsonb, NULL, $3)", [
        event,
        JSON.stringify({ nameEn: "Hall", image: pic.id }),
        randomUUID(),
      ]);
      await query(teamA(), "SELECT sponsor_save($1, $2::jsonb, NULL, $3)", [
        event,
        JSON.stringify({ nameEn: "Acme", tier: "gold", logo: logo.id }),
        randomUUID(),
      ]);
      await owner(
        "UPDATE event SET ends_at = now() - interval '366 days', starts_at = now() - interval '367 days' WHERE id = $1",
        [event],
      );
      await query(SYSTEM, "SELECT media_purge_due(1000)");
      expect(await owner("SELECT image FROM event_map WHERE event_id = $1", [event])).toEqual([
        { image: null },
      ]);
      expect(await owner("SELECT logo FROM sponsor WHERE event_id = $1", [event])).toEqual([
        { logo: null },
      ]);
      expect(await exists(pic.id)).toBe(false);
    });

    it("strips every image id from a duplicated event", async () => {
      const source = await newEvent(ids.orgA, "draft");
      const logo = await image(source, "logo");
      const slide = await image(source, "banner");
      const config = {
        branding: { accent: "sky", logo: logo.id, banner: slide.id },
        layout: {
          content: {
            banner: [{ title: { ar: "", en: "Hi" }, image: slide.id }],
            cards: [{ id: "abcdef", kind: "text", body: { ar: "", en: "x" }, image: slide.id }],
            featured: { kind: "quest", id: randomUUID(), image: slide.id },
            page: {
              title: { ar: "", en: "P" },
              blocks: [
                { kind: "text", text: { ar: "", en: "t" } },
                { kind: "image", image: slide.id, alt: { ar: "", en: "a" } },
              ],
            },
          },
        },
      };
      await owner("UPDATE event SET config = config || $2::jsonb WHERE id = $1", [
        source,
        JSON.stringify(config),
      ]);
      const target = await newEvent(ids.orgA, "draft");
      await query({ ...teamA(), repeatableRead: true }, "SELECT event_copy_setup($1, $2, $3)", [
        source,
        target,
        randomUUID(),
      ]);
      const [copied] = await owner<{ config: Record<string, unknown> }>(
        "SELECT config FROM event WHERE id = $1",
        [target],
      );
      const text = JSON.stringify(copied?.config);
      expect(text).not.toContain(logo.id);
      expect(text).not.toContain(slide.id);
      expect(copied?.config["branding"]).toEqual({ accent: "sky" });
      await owner("UPDATE event SET config = '{}'::jsonb WHERE id = $1", [target]);
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
        [target],
      );
      await owner(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'vote', 'Pick', 10, $3)`,
        [
          target,
          category?.id,
          JSON.stringify({
            options: [
              { id: "a", text: { ar: "", en: "A" }, image: logo.id },
              { id: "b", text: { ar: "", en: "B" } },
            ],
          }),
        ],
      );
      await owner("SELECT media_refs_strip_event($1)", [target]);
      const [vote] = await owner<{ c: unknown }>(
        "SELECT type_config AS c FROM quest WHERE event_id = $1",
        [target],
      );
      expect(JSON.stringify(vote?.c)).not.toContain(logo.id);
    });
  });

  describe("the quest shapes", () => {
    it("takes game art by game and image ids on vote options, and refuses anything else", async () => {
      const event = await newEvent();
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
        [event],
      );
      const id = randomUUID();
      const game = (name: string, images: unknown) =>
        owner(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
           VALUES ($1, $2, 'game', 'G', 10, $3)`,
          [
            event,
            category?.id,
            JSON.stringify({
              game: name,
              level: "easy",
              attempts: 3,
              cooldownMinutes: null,
              images,
            }),
          ],
        );
      expect(await refusal(game("memory_match", { faces: [id] }))).toBe("none");
      expect(await refusal(game("memory_match", { faces: Array(11).fill(id) }))).toBe("23514");
      expect(await refusal(game("memory_match", { picture: id }))).toBe("23514");
      expect(await refusal(game("slide_puzzle", { picture: id }))).toBe("none");
      expect(await refusal(game("catch", { items: [id, id] }))).toBe("none");
      expect(await refusal(game("catch", { items: Array(6).fill(id) }))).toBe("23514");
      expect(await refusal(game("tap_rush", { items: [id] }))).toBe("23514");
      expect(await refusal(game("catch", { items: ["not-an-id"] }))).toBe("23514");
      const vote = (pic: unknown) =>
        owner(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
           VALUES ($1, $2, 'vote', 'V', 10, $3)`,
          [
            event,
            category?.id,
            JSON.stringify({
              options: [
                { id: "a", text: { ar: "", en: "A" }, image: pic },
                { id: "b", text: { ar: "", en: "B" } },
              ],
            }),
          ],
        );
      expect(await refusal(vote(id))).toBe("none");
      expect(await refusal(vote(42))).toBe("23514");
    });

    it("shows a member the art of a game and the images of a vote they may play", async () => {
      const event = await newEvent();
      const player = await member(event);
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
        [event],
      );
      const id = randomUUID();
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'vote', 'V', 10, $3) RETURNING id`,
        [
          event,
          category?.id,
          JSON.stringify({
            options: [
              { id: "a", text: { ar: "", en: "A" }, image: id },
              { id: "b", text: { ar: "", en: "B" } },
            ],
          }),
        ],
      );
      expect(
        await query({ playerId: player }, "SELECT member_quest_images($1) AS images", [quest?.id]),
      ).toEqual([{ images: { options: { a: id } } }]);
      expect(
        await query({ playerId: ids.playerB }, "SELECT member_quest_images($1) AS images", [
          quest?.id,
        ]),
      ).toEqual([{ images: null }]);
    });
  });
});
