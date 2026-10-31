import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Tag = { kind: string; targetId: string };
type Sponsor = Record<string, unknown> & { id: string; tier: string; tags: Tag[] };
type Draft = Record<string, unknown>;
type Seen = {
  sponsors: { id: string; name: { ar: string; en: string }; tier: string; booth: string | null }[];
  tags: { kind: string; targetId: string; sponsorId: string }[];
};

/** A call's SQLSTATE and detail ("SO409:limit"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const gold = (over: Draft = {}): Draft => ({ nameEn: "Acme", tier: "gold", ...over });

/**
 * Sponsors in the database (T-507, migration 0088; plan docs/plans/2026-10-30-t-507-sponsors.md, ADR-375): the team
 * writes sponsors and tags inside its event, an item has one sponsor, a sponsor's delete takes its tags with it, and a
 * player reads the sponsors with tags only on the quests, categories and rewards they may see.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("sponsors (database)", () => {
  let f: PushFixture;
  let event: string;
  beforeAll(async () => {
    f = await pushFixture();
    event = await f.newEvent({ phase: "live" });
  });
  afterAll(async () => {
    await f.close();
  });

  const save = (draft: Draft, target: string | null = null, ev = event, seat = f.team()) =>
    f.run<{ r: Sponsor }>(seat, "SELECT sponsor_save($1, $2::jsonb, $3, $4) AS r", [
      ev,
      JSON.stringify(draft),
      target,
      randomUUID(),
    ]);
  const make = async (draft: Draft = gold(), ev = event): Promise<string> =>
    (await save(draft, null, ev))[0]?.r.id ?? "";
  const list = async (ev = event, seat = f.team()) =>
    (await f.run<{ r: Sponsor[] }>(seat, "SELECT sponsor_list($1) AS r", [ev]))[0]?.r ?? [];
  const tag = (kind: string, item: string, sponsor: string | null, ev = event, seat = f.team()) =>
    f.run<{ r: Sponsor[] }>(seat, "SELECT sponsor_tag_set($1, $2, $3, $4, $5) AS r", [
      ev,
      kind,
      item,
      sponsor,
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
  const makeCategory = async (ev = event, hidden = false): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en, hidden) VALUES ($1, 'Zone', $2) RETURNING id",
        [ev, hidden],
      )
    )[0]?.id ?? "";
  const makeReward = async (ev = event, extra = ""): Promise<string> =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total ${extra === "" ? "" : ", audience_kind, audience_values"})
         VALUES ($1, 'item', 'Cap', 50, 9 ${extra}) RETURNING id`,
        [ev],
      )
    )[0]?.id ?? "";
  const seen = async (who: string, ev = event): Promise<Seen> =>
    (await f.run<{ r: Seen }>({ playerId: who }, "SELECT member_sponsors($1) AS r", [ev]))[0]
      ?.r as Seen;

  it("adds sponsors with a name in one language, a tier and a booth, and refuses what does not fit", async () => {
    const id = await make(gold({ nameAr: "شركة", booth: "B14" }));
    expect((await list()).find((row) => row.id === id)).toMatchObject({
      nameAr: "شركة",
      nameEn: "Acme",
      tier: "gold",
      booth: "B14",
      tags: [],
    });
    const renamed = (await save({ nameAr: "الراعي", tier: "silver" }, id))[0]?.r;
    expect(renamed).toMatchObject({ nameAr: "الراعي", nameEn: null, tier: "silver", booth: null });
    const cases: [Draft, string][] = [
      [{ tier: "gold" }, "PS422:name"],
      [gold({ nameEn: "   " }), "PS422:name"],
      [gold({ nameEn: "x".repeat(61) }), "PS422:nameEn"],
      [gold({ nameEn: "tab\there" }), "PS422:nameEn"],
      [gold({ tier: "diamond" }), "PS422:tier"],
      [{ nameEn: "No tier" }, "PS422:tier"],
      [gold({ tier: 3 }), "PS422:tier"],
      [gold({ booth: "b".repeat(41) }), "PS422:booth"],
      [gold({ booth: 7 }), "PS422:booth"],
    ];
    for (const [draft, expected] of cases)
      expect(await refusal(save(draft)), JSON.stringify(draft)).toBe(expected);
    expect(await refusal(save(gold(), randomUUID()))).toBe("SO404");
    expect(
      await refusal(
        f.run(f.team(), "SELECT sponsor_save($1, '[]'::jsonb, NULL, $2)", [event, randomUUID()]),
      ),
    ).toBe("PS422:sponsor");
  });

  it("lists sponsors by tier, then by when they were added", async () => {
    const solo = await f.newEvent({ phase: "live" });
    const partner = await make(gold({ nameEn: "P", tier: "partner" }), solo);
    const goldTwo = await make(gold({ nameEn: "G2" }), solo);
    const platinum = await make(gold({ nameEn: "Plat", tier: "platinum" }), solo);
    const goldOne = await make(gold({ nameEn: "G3" }), solo);
    expect((await list(solo)).map((row) => row.id)).toEqual([platinum, goldTwo, goldOne, partner]);
  });

  it("tags a quest, a category and a reward, moves an item to another sponsor, and clears a tag", async () => {
    const [a, b] = [await make(gold({ nameEn: "A" })), await make(gold({ nameEn: "B" }))];
    const [quest, category, reward] = [await makeQuest(), await makeCategory(), await makeReward()];
    await tag("quest", quest, a);
    await tag("category", category, a);
    const both = (await tag("reward", reward, a))[0]?.r ?? [];
    expect(both.find((row) => row.id === a)?.tags).toEqual([
      { kind: "quest", targetId: quest },
      { kind: "category", targetId: category },
      { kind: "reward", targetId: reward },
    ]);
    const moved = (await tag("quest", quest, b))[0]?.r ?? [];
    expect(moved.find((row) => row.id === a)?.tags.map((entry) => entry.kind)).toEqual([
      "category",
      "reward",
    ]);
    expect(moved.find((row) => row.id === b)?.tags).toEqual([{ kind: "quest", targetId: quest }]);
    const cleared = (await tag("quest", quest, null))[0]?.r ?? [];
    expect(cleared.find((row) => row.id === b)?.tags).toEqual([]);
    expect(await tag("quest", quest, null)).toBeTruthy();
  });

  it("refuses a tag for something that is not of the event, and a kind it does not know", async () => {
    const sponsor = await make();
    const other = await f.newEvent({ phase: "live" });
    const [foreignQuest, foreignCategory, foreignReward] = [
      await makeQuest(other),
      await makeCategory(other),
      await makeReward(other),
    ];
    const foreignSponsor = await make(gold(), other);
    expect(await refusal(tag("quest", foreignQuest, sponsor))).toBe("SO404");
    expect(await refusal(tag("category", foreignCategory, sponsor))).toBe("SO404");
    expect(await refusal(tag("reward", foreignReward, sponsor))).toBe("SO404");
    expect(await refusal(tag("quest", await makeQuest(), foreignSponsor))).toBe("SO404");
    expect(await refusal(tag("quest", randomUUID(), sponsor))).toBe("SO404");
    expect(await refusal(tag("souvenir", randomUUID(), sponsor))).toBe("PS422:kind");
    const removed = await makeReward();
    await f.owner("UPDATE reward SET status = 'removed' WHERE id = $1", [removed]);
    expect(await refusal(tag("reward", removed, sponsor))).toBe("SO404");
  });

  it("answers a tag whose item is deleted between the check and the insert as not found, not a fault", async () => {
    const sponsor = await make();
    const quest = await makeQuest();
    const [database] = await f.owner<{ name: string }>("SELECT current_database() AS name");
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${database?.name ?? ""}`;
    const deleter = new Client({ connectionString: url.toString() });
    await deleter.connect();
    try {
      await deleter.query("BEGIN");
      await deleter.query("DELETE FROM quest WHERE id = $1", [quest]);
      const pending = refusal(tag("quest", quest, sponsor));
      let waiting = false;
      for (let attempt = 0; attempt < 300 && !waiting; attempt += 1) {
        waiting =
          (
            await f.owner(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%sponsor_tag_set%'",
            )
          ).length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await deleter.query("COMMIT");
      expect(await pending).toBe("SO404");
    } finally {
      await deleter.end();
    }
  });

  it("holds a tag one-per-item when two writes race, and takes the tags with a deleted sponsor", async () => {
    const [a, b] = [await make(gold({ nameEn: "RA" })), await make(gold({ nameEn: "RB" }))];
    const quest = await makeQuest();
    const outcomes = await Promise.all([
      refusal(tag("quest", quest, a)),
      refusal(tag("quest", quest, b)),
    ]);
    expect(outcomes).toEqual(["none", "none"]);
    const [tags] = await f.owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM sponsor_tag WHERE quest_id = $1",
      [quest],
    );
    expect(tags?.n).toBe(1);
    const holder = (await list()).find((row) => row.tags.some((entry) => entry.targetId === quest));
    const lost = await f.run<{ r: number }>(f.team(), "SELECT sponsor_delete($1, $2, $3) AS r", [
      event,
      holder?.id,
      randomUUID(),
    ]);
    expect(lost[0]?.r).toBe(1);
    expect((await list()).some((row) => row.id === holder?.id)).toBe(false);
    expect(
      await refusal(
        f.run(f.team(), "SELECT sponsor_delete($1, $2, $3)", [event, holder?.id, randomUUID()]),
      ),
    ).toBe("SO404");
  });

  it("takes a tag away with its quest, its category or its reward, and stops listing a removed reward", async () => {
    const sponsor = await make(gold({ nameEn: "Cascade" }));
    const [quest, category, reward] = [await makeQuest(), await makeCategory(), await makeReward()];
    for (const [kind, item] of [
      ["quest", quest],
      ["category", category],
      ["reward", reward],
    ] as const)
      await tag(kind, item, sponsor);
    await f.owner("UPDATE reward SET status = 'removed' WHERE id = $1", [reward]);
    const row = (await list()).find((entry) => entry.id === sponsor);
    expect(row?.tags.map((entry) => entry.kind)).toEqual(["quest", "category"]);
    await f.owner("DELETE FROM quest WHERE id = $1", [quest]);
    await f.owner("DELETE FROM category WHERE id = $1", [category]);
    expect((await list()).find((entry) => entry.id === sponsor)?.tags).toEqual([]);
  });

  it("holds the cap of 100 sponsors per event", async () => {
    const crowded = await f.newEvent({ phase: "live" });
    await f.owner(
      `INSERT INTO sponsor (organizer_id, event_id, name_en, tier, created_by)
       SELECT $1, $2, 'S' || n, 'partner', $3 FROM generate_series(1, 100) n`,
      [f.ids.orgA, crowded, f.ownerA],
    );
    expect(await refusal(save(gold(), null, crowded))).toBe("SO409:limit");
  });

  it("refuses writes on an archived event and writes an audit row without a name for each change", async () => {
    const archived = await f.newEvent({ phase: "archived" });
    expect(await refusal(save(gold(), null, archived))).toBe("SO409:event_closed");
    expect(await refusal(tag("quest", randomUUID(), randomUUID(), archived))).toBe(
      "SO409:event_closed",
    );
    const actions = await f.owner<{ action: string; after: unknown }>(
      `SELECT DISTINCT action, after FROM audit_log WHERE event_id = $1 AND action LIKE 'sponsor.%'`,
      [event],
    );
    expect(new Set(actions.map((row) => row.action))).toEqual(
      new Set(["sponsor.save", "sponsor.tag", "sponsor.delete"]),
    );
    expect(JSON.stringify(actions)).not.toContain("Acme");
  });

  it("shows a player the sponsors in order and tags only on what they may see", async () => {
    const solo = await f.newEvent({ phase: "live" });
    const [plat, other] = [
      await make(gold({ nameEn: "Plat", nameAr: "ماسي", tier: "platinum", booth: "A1" }), solo),
      await make(gold({ nameEn: "Other", tier: "bronze" }), solo),
    ];
    const shown = await makeQuest(solo);
    const hidden = await makeQuest(solo, { visible: false });
    const sealed = await makeQuest(solo);
    const secret = await makeCategory(solo, true);
    await f.owner("UPDATE quest SET category_id = $1 WHERE id = $2", [secret, sealed]);
    const openCategory = await makeCategory(solo);
    const openReward = await makeReward(solo);
    const targeted = await makeReward(solo, ", 'tag', ARRAY['vip']");
    await tag("quest", shown, plat, solo);
    await tag("quest", hidden, plat, solo);
    await tag("quest", sealed, other, solo);
    await tag("category", openCategory, plat, solo);
    await tag("category", secret, plat, solo);
    await tag("reward", openReward, other, solo);
    await tag("reward", targeted, other, solo);

    const who = await f.newPlayer();
    await f.join(solo, who);
    const read = await seen(who, solo);
    expect(read.sponsors).toEqual([
      { id: plat, name: { ar: "ماسي", en: "Plat" }, tier: "platinum", booth: "A1" },
      { id: other, name: { ar: "Other", en: "Other" }, tier: "bronze", booth: null },
    ]);
    expect(read.tags).toEqual([
      { kind: "quest", targetId: shown, sponsorId: plat },
      { kind: "category", targetId: openCategory, sponsorId: plat },
      { kind: "reward", targetId: openReward, sponsorId: other },
    ]);
    const text = JSON.stringify(read);
    for (const secretId of [hidden, sealed, secret, targeted])
      expect(text, secretId).not.toContain(secretId);
  });

  it("refuses anyone who is not an active member, and a team seat on the player door", async () => {
    const stranger = await f.newPlayer();
    expect(
      await refusal(f.run({ playerId: stranger }, "SELECT member_sponsors($1)", [event])),
    ).toBe("AM403");
    const who = await f.newPlayer();
    await f.join(event, who);
    await f.owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1 AND event_id = $2", [
      who,
      event,
    ]);
    expect(await refusal(f.run({ playerId: who }, "SELECT member_sponsors($1)", [event]))).toBe(
      "AM403",
    );
    expect(await refusal(f.run(f.team(), "SELECT member_sponsors($1)", [event]))).toBe("AM403");
  });

  it("holds a sponsor to a name, a tier and a booth: no contact, link or player column exists", async () => {
    const columns = await f.owner<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('sponsor', 'sponsor_tag')
       ORDER BY table_name, ordinal_position`,
    );
    const by = (table: string) =>
      columns.filter((row) => row.table_name === table).map((row) => row.column_name);
    expect(by("sponsor")).toEqual([
      "id",
      "organizer_id",
      "event_id",
      "name_ar",
      "name_en",
      "tier",
      "booth",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    expect(by("sponsor_tag")).toEqual([
      "id",
      "organizer_id",
      "event_id",
      "sponsor_id",
      "kind",
      "quest_id",
      "category_id",
      "reward_id",
      "created_by",
      "created_at",
    ]);
  });
});
