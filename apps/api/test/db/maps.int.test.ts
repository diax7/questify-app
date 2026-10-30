import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Pin = Record<string, unknown> & { id: string; kind: string; questId: string | null };
type MapItem = Record<string, unknown> & { id: string; position: number; pins: Pin[] };
type Draft = Record<string, unknown>;
type Seen = {
  maps: { id: string; name: { ar: string; en: string }; pins: Record<string, unknown>[] }[];
  here: { pinId: string; at: string } | null;
};

/** A call's SQLSTATE and detail ("MP409:quest_pinned"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const booth = (over: Draft = {}): Draft => ({
  kind: "booth",
  nameEn: "Booth 1",
  x: 100,
  y: 200,
  ...over,
});

/**
 * Event maps in the database (T-506, migration 0087; plan docs/plans/2026-10-30-t-506-maps.md, ADR-374): the team writes
 * maps and pins inside its event, a quest has one pin, a map write takes turns with the others, and a player reads the
 * maps with quest pins only for quests they may list and "you are here" only from their own station scans.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("maps (database)", () => {
  let f: PushFixture;
  let event: string;
  beforeAll(async () => {
    f = await pushFixture();
    event = await f.newEvent({ phase: "live" });
  });
  afterAll(async () => {
    await f.close();
  });

  const saveMap = (nameEn: string | null, target: string | null = null, seat = f.team()) =>
    f.run<{ r: MapItem }>(seat, "SELECT map_save($1, $2::jsonb, $3, $4) AS r", [
      event,
      JSON.stringify(nameEn === null ? {} : { nameEn }),
      target,
      randomUUID(),
    ]);
  const makeMap = async (nameEn = "Floor"): Promise<string> =>
    (await saveMap(nameEn))[0]?.r.id ?? "";
  const maps = async (seat: RequestContext = f.team()) =>
    (await f.run<{ r: MapItem[] }>(seat, "SELECT map_list($1) AS r", [event]))[0]?.r ?? [];
  const savePin = (map: string, draft: Draft, target: string | null = null, ev = event) =>
    f.run<{ r: MapItem }>(f.team(), "SELECT map_pin_save($1, $2, $3::jsonb, $4, $5) AS r", [
      ev,
      map,
      JSON.stringify(draft),
      target,
      randomUUID(),
    ]);
  const makeQuest = async (ev = event, over: { visible?: boolean } = {}): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, 'scan_qr', 'Station', 25, 3, $2, '{}' FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [ev, over.visible ?? true],
      )
    )[0]?.id ?? "";
  const member = async () => {
    const who = await f.newPlayer();
    const enrollment = await f.join(event, who);
    return { who, enrollment };
  };
  const scan = async (enrollment: string, quest: string, method: string, ago: number) => {
    const [done] = await f.owner<{ occurrence: number }>(
      `SELECT coalesce(max(occurrence), 0)::int + 1 AS occurrence FROM quest_completion
       WHERE enrollment_id = $1 AND quest_id = $2`,
      [enrollment, quest],
    );
    await f.owner(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8))`,
      [f.ids.orgA, event, enrollment, quest, done?.occurrence, method, randomUUID(), ago],
    );
  };
  const seen = async (who: string): Promise<Seen> =>
    (await f.run<{ r: Seen }>({ playerId: who }, "SELECT member_maps($1) AS r", [event]))[0]
      ?.r as Seen;

  it("adds maps in order, renames one, and wants a name in one language at least", async () => {
    const first = await makeMap("Floor 1");
    const second = await makeMap("Floor 2");
    expect((await maps()).map((row) => [row.id, row.position])).toEqual([
      [first, 1],
      [second, 2],
    ]);
    const renamed = (await saveMap("Ground floor", first))[0]?.r;
    expect(renamed).toMatchObject({ id: first, nameEn: "Ground floor", position: 1 });
    expect(await refusal(saveMap(null))).toBe("PS422:name");
    expect(await refusal(saveMap("x".repeat(61)))).toBe("PS422:nameEn");
    expect(await refusal(saveMap("Nowhere", randomUUID()))).toBe("MP404");
    expect(await refusal(saveMap("   "))).toBe("PS422:name");
  });

  it("orders the maps and keeps the order dense after a delete", async () => {
    const ids = (await maps()).map((row) => row.id);
    const extra = await makeMap("Outdoor");
    const wanted = [extra, ...ids];
    const ordered = await f.run<{ r: MapItem[] }>(
      f.team(),
      "SELECT map_order($1, $2::uuid[], $3) AS r",
      [event, wanted, randomUUID()],
    );
    expect(ordered[0]?.r.map((row) => row.id)).toEqual(wanted);
    for (const bad of [
      ids,
      [...wanted, wanted[0]],
      [extra, extra, ...ids.slice(1)],
      [randomUUID(), ...ids],
    ]) {
      expect(
        await refusal(
          f.run(f.team(), "SELECT map_order($1, $2::uuid[], $3)", [event, bad, randomUUID()]),
        ),
        JSON.stringify(bad),
      ).toBe("PS422:order");
    }
    await f.run(f.team(), "SELECT map_delete($1, $2, $3)", [event, extra, randomUUID()]);
    expect((await maps()).map((row) => row.position)).toEqual([1, 2]);
    expect(
      await refusal(f.run(f.team(), "SELECT map_delete($1, $2, $3)", [event, extra, randomUUID()])),
    ).toBe("MP404");
  });

  it("holds the shape of each pin kind and refuses what does not fit", async () => {
    const map = await makeMap("Pins");
    const made = (await savePin(map, booth({ detailsEn: "Ask for Sara" })))[0]?.r;
    expect(made?.pins.at(-1)).toMatchObject({ kind: "booth", nameEn: "Booth 1", x: 100, y: 200 });
    await savePin(map, { kind: "section", nameAr: "القاعة", x: 0, y: 1000 });
    await savePin(map, { kind: "amenity", amenity: "prayer", x: 5, y: 5 });
    const quest = await makeQuest();
    const withQuest = (await savePin(map, { kind: "quest", questId: quest, x: 500, y: 500 }))[0]?.r;
    expect(withQuest?.pins.at(-1)).toMatchObject({ kind: "quest", questId: quest, nameEn: null });
    const cases: [Draft, string][] = [
      [booth({ kind: "castle" }), "PS422:kind"],
      [booth({ x: 1001 }), "PS422:x"],
      [booth({ y: -1 }), "PS422:y"],
      [booth({ x: null }), "PS422:place"],
      [booth({ nameEn: null }), "PS422:name"],
      [booth({ nameEn: "tab\there" }), "PS422:nameEn"],
      [booth({ detailsEn: "y".repeat(501) }), "PS422:detailsEn"],
      [{ kind: "amenity", x: 1, y: 1 }, "PS422:amenity"],
      [{ kind: "amenity", amenity: "bar", x: 1, y: 1 }, "PS422:amenity"],
      [{ kind: "quest", x: 1, y: 1 }, "PS422:questId"],
      [{ kind: "quest", questId: randomUUID(), x: 1, y: 1 }, "PS422:questId"],
      [{ kind: "quest", questId: "not-a-uuid", x: 1, y: 1 }, "PS422:questId"],
      [{ kind: "quest", questId: "-".repeat(36), x: 1, y: 1 }, "PS422:questId"],
    ];
    for (const [draft, expected] of cases)
      expect(await refusal(savePin(map, draft)), JSON.stringify(draft)).toBe(expected);
    expect(await refusal(savePin(randomUUID(), booth()))).toBe("MP404");
  });

  it("gives a quest one pin, lets its own pin be edited, and takes a deleted quest's pin with it", async () => {
    const map = await makeMap("One pin");
    const other = await makeMap("Another");
    const quest = await makeQuest();
    const first = (await savePin(map, { kind: "quest", questId: quest, x: 1, y: 1 }))[0]?.r;
    const pinId = first?.pins.at(-1)?.id ?? "";
    expect(await refusal(savePin(other, { kind: "quest", questId: quest, x: 2, y: 2 }))).toBe(
      "MP409:quest_pinned",
    );
    const moved = (await savePin(map, { kind: "quest", questId: quest, x: 900, y: 900 }, pinId))[0]
      ?.r;
    expect(moved?.pins.find((pin) => pin.id === pinId)).toMatchObject({ x: 900, y: 900 });
    expect(await refusal(savePin(other, booth(), pinId))).toBe("MP404");
    const foreignEvent = await f.newEvent({ phase: "live" });
    const foreignQuest = await makeQuest(foreignEvent);
    expect(await refusal(savePin(map, { kind: "quest", questId: foreignQuest, x: 3, y: 3 }))).toBe(
      "PS422:questId",
    );
    await f.owner("DELETE FROM quest WHERE id = $1", [quest]);
    expect((await maps()).find((row) => row.id === map)?.pins).toEqual([]);
  });

  it("lets two writes for one quest through once, and holds the pin and map caps", async () => {
    const [a, b] = [await makeMap("Race A"), await makeMap("Race B")];
    const quest = await makeQuest();
    const outcomes = await Promise.all(
      [a, b].map((map) => refusal(savePin(map, { kind: "quest", questId: quest, x: 7, y: 7 }))),
    );
    expect(outcomes.toSorted()).toEqual(["MP409:quest_pinned", "none"]);

    const full = await makeMap("Full");
    await f.owner(
      `INSERT INTO map_pin (organizer_id, event_id, map_id, kind, name_en, x, y, created_by)
       SELECT $1, $2, $3, 'booth', 'B' || n, 1, 1, $4 FROM generate_series(1, 300) n`,
      [f.ids.orgA, event, full, f.ownerA],
    );
    expect(await refusal(savePin(full, booth()))).toBe("MP409:pin_limit");

    const crowded = await f.newEvent({ phase: "live" });
    await f.owner(
      `INSERT INTO event_map (organizer_id, event_id, name_en, position, created_by)
       SELECT $1, $2, 'M' || n, n, $3 FROM generate_series(1, 50) n`,
      [f.ids.orgA, crowded, f.ownerA],
    );
    expect(
      await refusal(
        f.run(f.team(), 'SELECT map_save($1, \'{"nameEn":"One more"}\'::jsonb, NULL, $2)', [
          crowded,
          randomUUID(),
        ]),
      ),
    ).toBe("MP409:limit");
  });

  it("refuses writes on an archived event and writes an audit row for each change", async () => {
    const archived = await f.newEvent({ phase: "archived" });
    expect(
      await refusal(
        f.run(f.team(), 'SELECT map_save($1, \'{"nameEn":"Late"}\'::jsonb, NULL, $2)', [
          archived,
          randomUUID(),
        ]),
      ),
    ).toBe("MP409:event_closed");
    const actions = await f.owner<{ action: string }>(
      `SELECT DISTINCT action FROM audit_log WHERE event_id = $1 AND action LIKE 'map.%'`,
      [event],
    );
    expect(actions.map((row) => row.action).toSorted()).toEqual([
      "map.delete",
      "map.order",
      "map.pin_save",
      "map.save",
    ]);
  });

  it("shows a player the maps in order, with pins named in both languages and a quest pin only while they may list it", async () => {
    const solo = await f.newEvent({ phase: "live" });
    const mapId = (
      await f.run<{ r: MapItem }>(f.team(), "SELECT map_save($1, $2::jsonb, NULL, $3) AS r", [
        solo,
        JSON.stringify({ nameEn: "Hall", nameAr: "القاعة" }),
        randomUUID(),
      ])
    )[0]?.r.id as string;
    const put = (draft: Draft) =>
      f.run(f.team(), "SELECT map_pin_save($1, $2, $3::jsonb, NULL, $4)", [
        solo,
        mapId,
        JSON.stringify(draft),
        randomUUID(),
      ]);
    const shown = await makeQuest(solo);
    const hidden = await makeQuest(solo, { visible: false });
    const sealed = await makeQuest(solo);
    const [sealedCategory] = await f.owner<{ id: string }>(
      `INSERT INTO category (event_id, name_en, hidden) VALUES ($1, 'Secret', true) RETURNING id`,
      [solo],
    );
    await f.owner("UPDATE quest SET category_id = $1 WHERE id = $2", [sealedCategory?.id, sealed]);
    await put({ kind: "section", nameEn: "Main hall", x: 10, y: 10 });
    await put({ kind: "amenity", amenity: "toilets", nameAr: "دورات المياه", x: 20, y: 20 });
    await put({ kind: "quest", questId: shown, x: 30, y: 30 });
    await put({ kind: "quest", questId: hidden, x: 40, y: 40 });
    await put({ kind: "quest", questId: sealed, x: 50, y: 50 });

    const who = await f.newPlayer();
    await f.join(solo, who);
    const read = (
      await f.run<{ r: Seen }>({ playerId: who }, "SELECT member_maps($1) AS r", [solo])
    )[0]?.r as Seen;
    expect(read.maps).toHaveLength(1);
    expect(read.maps[0]?.name).toEqual({ ar: "القاعة", en: "Hall" });
    const pins = read.maps[0]?.pins ?? [];
    expect(pins.map((pin) => pin["kind"])).toEqual(["section", "amenity", "quest"]);
    expect(pins[0]?.["name"]).toEqual({ ar: "Main hall", en: "Main hall" });
    expect(pins[1]?.["name"]).toEqual({ ar: "دورات المياه", en: "دورات المياه" });
    expect(pins[2]).toMatchObject({ questId: shown, name: null });
    expect(read.here).toBeNull();
    expect(JSON.stringify(read)).not.toContain(hidden);
    expect(JSON.stringify(read)).not.toContain(sealed);
  });

  it("refuses anyone who is not an active member, and a team seat on the player door", async () => {
    const stranger = await f.newPlayer();
    expect(await refusal(f.run({ playerId: stranger }, "SELECT member_maps($1)", [event]))).toBe(
      "AM403",
    );
    const { who } = await member();
    await f.owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1 AND event_id = $2", [
      who,
      event,
    ]);
    expect(await refusal(f.run({ playerId: who }, "SELECT member_maps($1)", [event]))).toBe(
      "AM403",
    );
    expect(await refusal(f.run(f.team(), "SELECT member_maps($1)", [event]))).toBe("AM403");
  });

  it("marks 'you are here' at the last station scan only, and only from the caller's own scans", async () => {
    const map = await makeMap("Here");
    const [one, two, three] = [await makeQuest(), await makeQuest(), await makeQuest()];
    const pinOf = async (quest: string, x: number): Promise<string> =>
      (await savePin(map, { kind: "quest", questId: quest, x, y: 1 }))[0]?.r.pins.find(
        (pin) => pin.questId === quest,
      )?.id ?? "";
    const [pinOne, pinTwo] = [await pinOf(one, 10), await pinOf(two, 20)];
    const me = await member();
    const other = await member();
    expect((await seen(me.who)).here).toBeNull();

    await scan(me.enrollment, one, "qr", 30);
    expect((await seen(me.who)).here?.pinId).toBe(pinOne);
    await scan(me.enrollment, two, "my_qr", 20);
    expect((await seen(me.who)).here?.pinId).toBe(pinTwo);
    expect((await seen(other.who)).here).toBeNull();

    await scan(me.enrollment, one, "manual", 10);
    await scan(me.enrollment, one, "submission", 5);
    expect((await seen(me.who)).here?.pinId).toBe(pinTwo);

    await scan(me.enrollment, three, "nfc", 1);
    expect((await seen(me.who)).here).toBeNull();
    await scan(other.enrollment, one, "location", 0);
    expect((await seen(other.who)).here?.pinId).toBe(pinOne);
    expect((await seen(me.who)).here).toBeNull();
  });
});
