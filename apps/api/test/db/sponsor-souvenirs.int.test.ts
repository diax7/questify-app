import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sponsorRawSchema } from "@questify/shared";
import type { RequestContext } from "#src/db/context";
import { souvenirFixture } from "#test/support/souvenirs";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

type Sponsor = { id: string; tier: string; tags: { kind: string; targetId: string }[] };
type PresentedBy = { name: { ar: string; en: string }; tier: string };
type LockerRow = {
  item: { id: string; [key: string]: unknown };
  presented_by: PresentedBy | null;
  source: string;
};
type RecapItem = { id: string; presentedBy: PresentedBy | null };

/** A call's SQLSTATE and detail ("SO409:event_closed"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

/**
 * Souvenir sponsor tags in the database (T-507c, migration 0143; plan docs/plans/2026-11-03-t-507c-souvenir-sponsor-tags.md,
 * ADR-570 to ADR-574): the team tags a souvenir rule of its own event to one of the event's sponsors, the souvenir's owner
 * sees "presented by" on it in their locker and recap, and nothing public or event-wide carries it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("souvenir sponsor tags (database)", () => {
  let f: Awaited<ReturnType<typeof souvenirFixture>>;
  let foreignRule: string;
  let teamB: RequestContext;

  beforeAll(async () => {
    f = await souvenirFixture();
    teamB = { organizerId: f.ids.orgB, staffUserId: await addMember(f.db.owner, f.ids.orgB) };
    await f.db.owner.query(
      "INSERT INTO item (id, kind, name_ar, name_en, visual_key) VALUES ('souvenir-foreign-rule', 'title', 'عنصر', 'Item', NULL)",
    );
    foreignRule = (
      await f.db.owner.query(
        "INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience) VALUES ($1, $2, 'souvenir-foreign-rule', 'joined') RETURNING id",
        [f.ids.orgB, f.ids.eventB],
      )
    ).rows[0].id as string;
  });
  afterAll(async () => {
    await f.close();
  });

  const me = (): RequestContext => ({ playerId: f.ids.playerA });
  const sponsor = async (nameEn: string | null = "Acme", over: Record<string, unknown> = {}) =>
    (
      await f.run(f.actor, "SELECT sponsor_save($1, $2::jsonb, NULL, $3) AS r", [
        f.ids.eventA,
        JSON.stringify({ nameEn, tier: "gold", ...over }),
        randomUUID(),
      ])
    ).rows[0].r.id as string;
  const tag = (
    kind: string,
    item: string,
    sponsorId: string | null,
    seat: RequestContext = f.actor,
    event = f.ids.eventA,
  ) =>
    f.run(seat, "SELECT sponsor_tag_set($1, $2, $3, $4, $5) AS r", [
      event,
      kind,
      item,
      sponsorId,
      randomUUID(),
    ]);
  const listed = async (): Promise<Sponsor[]> =>
    (await f.run(f.actor, "SELECT sponsor_list($1) AS r", [f.ids.eventA])).rows[0].r;
  const tagsOf = async (rule: string): Promise<number> =>
    (
      await f.db.owner.query("SELECT count(*)::int AS n FROM sponsor_tag WHERE souvenir_id = $1", [
        rule,
      ])
    ).rows[0].n;
  const itemOf = async (rule: string): Promise<string> =>
    (await f.db.owner.query("SELECT item_id FROM souvenir_rule WHERE id = $1", [rule])).rows[0]
      .item_id;
  /** A souvenir player A owns: a new active rule granted to the fixture's member. */
  const earned = async (): Promise<string> => {
    const rule = await f.create();
    await f.action(rule);
    await f.grant();
    return rule;
  };
  const lockerOf = async (who: RequestContext = me()): Promise<LockerRow[]> =>
    (await f.run(who, "SELECT * FROM own_locker(NULL, NULL, 100)")).rows;
  const labelOf = async (rule: string): Promise<PresentedBy | null | undefined> => {
    const item = await itemOf(rule);
    return (await lockerOf()).find((row) => row.item.id === item)?.presented_by;
  };
  const recapOf = async (who: RequestContext = me()): Promise<RecapItem[]> =>
    (await f.run(who, "SELECT souvenirs FROM event_recap($1)", [f.ids.eventA])).rows[0]
      ?.souvenirs ?? [];

  it("tags a draft, an active and a stopped souvenir, moves the tag and clears it", async () => {
    const [first, second] = [await sponsor("First"), await sponsor("Second")];
    const rule = await f.create();
    const draft = (await tag("souvenir", rule, first)).rows[0].r as Sponsor[];
    expect(draft.find((row) => row.id === first)?.tags).toEqual([
      { kind: "souvenir", targetId: rule },
    ]);
    await f.action(rule);
    const moved = (await tag("souvenir", rule, second)).rows[0].r as Sponsor[];
    expect(moved.find((row) => row.id === first)?.tags).toEqual([]);
    expect(moved.find((row) => row.id === second)?.tags).toEqual([
      { kind: "souvenir", targetId: rule },
    ]);
    await f.action(rule, "stop");
    await tag("souvenir", rule, first);
    expect((await listed()).find((row) => row.id === first)?.tags).toEqual([
      { kind: "souvenir", targetId: rule },
    ]);
    await tag("souvenir", rule, null);
    expect(await tagsOf(rule)).toBe(0);
    expect(await refusal(tag("souvenir", rule, null))).toBe("none");
  });

  it("shows the sponsor on the owner's locker and recap, and none on an untagged souvenir", async () => {
    const acme = await sponsor("Acme", { nameAr: "أكمي", tier: "platinum" });
    const [tagged, plain] = [await earned(), await earned()];
    await tag("souvenir", tagged, acme);
    // The logo and its event (T-507b, 0194) ride along; null while the sponsor has none.
    const label = {
      name: { ar: "أكمي", en: "Acme" },
      tier: "platinum",
      logo: null,
      eventId: f.ids.eventA,
    };
    const [taggedItem, plainItem] = [await itemOf(tagged), await itemOf(plain)];
    const locker = await lockerOf();
    const row = locker.find((entry) => entry.item.id === taggedItem);
    expect(row?.source).toBe("souvenir");
    expect(row?.presented_by).toEqual(label);
    expect(locker.find((entry) => entry.item.id === plainItem)?.presented_by).toBeNull();
    const recap = await recapOf();
    expect(recap.find((entry) => entry.id === taggedItem)?.presentedBy).toEqual(label);
    expect(recap.find((entry) => entry.id === plainItem)?.presentedBy).toBeNull();
  });

  it("follows the tag: another sponsor, a renamed sponsor, no tag, a deleted sponsor", async () => {
    const [one, two] = [await sponsor("One"), await sponsor("Two")];
    const rule = await earned();
    await tag("souvenir", rule, one);
    expect((await labelOf(rule))?.name.en).toBe("One");
    await tag("souvenir", rule, two);
    expect((await labelOf(rule))?.name.en).toBe("Two");
    await f.run(f.actor, "SELECT sponsor_save($1, $2::jsonb, $3, $4)", [
      f.ids.eventA,
      JSON.stringify({ nameEn: "Two renamed", tier: "bronze" }),
      two,
      randomUUID(),
    ]);
    expect(await labelOf(rule)).toEqual({
      name: { ar: "Two renamed", en: "Two renamed" },
      tier: "bronze",
      logo: null,
      eventId: f.ids.eventA,
    });
    await f.run(f.actor, "SELECT sponsor_delete($1, $2, $3)", [f.ids.eventA, two, randomUUID()]);
    expect(await tagsOf(rule)).toBe(0);
    expect(await labelOf(rule)).toBeNull();
    await tag("souvenir", rule, one);
    await tag("souvenir", rule, null);
    expect(await labelOf(rule)).toBeNull();
  });

  it("names a sponsor that has only an Arabic name in both languages", async () => {
    const arabicOnly = await sponsor(null, { nameAr: "الراعي" });
    const rule = await earned();
    await tag("souvenir", rule, arabicOnly);
    expect((await labelOf(rule))?.name).toEqual({ ar: "الراعي", en: "الراعي" });
  });

  it("shows a player who owns nothing no locker row and no recap row", async () => {
    const acme = await sponsor("Mine");
    await tag("souvenir", await earned(), acme);
    const stranger = (
      await f.db.owner.query(
        "INSERT INTO player (username) VALUES ('souvenir_outsider') RETURNING id",
      )
    ).rows[0].id as string;
    expect(await lockerOf({ playerId: stranger })).toEqual([]);
    expect(await recapOf({ playerId: stranger })).toEqual([]);
  });

  it("keeps the sponsor off every public item: item, equipment and public profile", async () => {
    const acme = await sponsor("Publicly Quiet", { nameAr: "هادئ علنًا" });
    const rule = await earned();
    await tag("souvenir", rule, acme);
    const item = await itemOf(rule);
    const row = (await lockerOf()).find((entry) => entry.item.id === item);
    expect(Object.keys(row?.item ?? {}).toSorted()).toEqual(["id", "kind", "name", "visualKey"]);
    await f.run(me(), "SELECT equip_player($1)", [{ frameId: item }]);
    const equipment = (await f.run(me(), "SELECT equipment FROM own_equipment()")).rows[0]
      .equipment;
    expect(Object.keys(equipment.frame).toSorted()).toEqual(["id", "kind", "name", "visualKey"]);
    const profile = (
      await f.run({ playerId: f.ids.playerB }, "SELECT public_player_profile('sara_k') AS p")
    ).rows[0].p;
    expect(profile.frame.id).toBe(item);
    for (const text of [JSON.stringify(equipment), JSON.stringify(profile)]) {
      expect(text).not.toContain("Publicly Quiet");
      expect(text).not.toContain("هادئ علنًا");
      expect(text).not.toContain(acme);
      expect(text).not.toMatch(/presented|sponsor/i);
    }
  });

  it("never lists a souvenir tag with the event's items for a player", async () => {
    const acme = await sponsor("Strip");
    const rule = await earned();
    await tag("souvenir", rule, acme);
    const read = (await f.run(me(), "SELECT member_sponsors($1) AS r", [f.ids.eventA])).rows[0].r;
    expect(read.sponsors.map((entry: { id: string }) => entry.id)).toContain(acme);
    expect(read.tags).toEqual([]);
    expect(JSON.stringify(read)).not.toContain(rule);
  });

  it("refuses what is not the team's own souvenir, sponsor or event", async () => {
    const acme = await sponsor("Guarded");
    const rule = await f.create();
    expect(await refusal(tag("souvenir", foreignRule, acme))).toBe("SO404");
    expect(await refusal(tag("souvenir", randomUUID(), acme))).toBe("SO404");
    expect(await refusal(tag("souvenir", rule, randomUUID()))).toBe("SO404");
    expect(await refusal(tag("souvenirs", rule, acme))).toBe("PS422:kind");
    expect(await refusal(tag("souvenir", rule, acme, f.actor, f.ids.eventB))).toBe("AN404");
    expect(await refusal(tag("souvenir", foreignRule, acme, teamB, f.ids.eventB))).toBe("SO404");
    expect(await refusal(tag("souvenir", rule, acme, teamB))).toBe("AN404");
    expect(await tagsOf(rule)).toBe(0);
    expect(await tagsOf(foreignRule)).toBe(0);
  });

  it("refuses a player, an anonymous caller, an editor out of scope and an archived event", async () => {
    const acme = await sponsor("Closed doors");
    const rule = await f.create();
    expect(await refusal(tag("souvenir", rule, acme, me()))).toBe("AN404");
    expect(await refusal(tag("souvenir", rule, acme, {}))).toBe("AN404");
    const elsewhere = (
      await f.db.owner.query(
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'SVELSE', 'Elsewhere') RETURNING id",
        [f.ids.orgA],
      )
    ).rows[0].id as string;
    const limited = await addMember(f.db.owner, f.ids.orgA, "editor", [elsewhere]);
    expect(await refusal(tag("souvenir", rule, acme, { ...f.actor, staffUserId: limited }))).toBe(
      "AN404",
    );
    const archived = (
      await f.db.owner.query(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'SVARCH', 'Old', 'archived', now() - interval '3 days', now() - interval '2 days') RETURNING id`,
        [f.ids.orgA],
      )
    ).rows[0].id as string;
    await f.db.owner.query(
      "INSERT INTO item (id, kind, name_ar, name_en) VALUES ('souvenir-old', 'title', 'قديم', 'Old')",
    );
    const old = (
      await f.db.owner.query(
        "INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience) VALUES ($1, $2, 'souvenir-old', 'joined') RETURNING id",
        [f.ids.orgA, archived],
      )
    ).rows[0].id as string;
    expect(await refusal(tag("souvenir", old, acme, f.actor, archived))).toBe("SO409:event_closed");
    expect(await tagsOf(rule)).toBe(0);
    expect(await tagsOf(old)).toBe(0);
  });

  it("holds one sponsor per souvenir under a race, and the table refuses a malformed tag", async () => {
    const [a, b] = [await sponsor("RaceA"), await sponsor("RaceB")];
    const rule = await f.create();
    expect(
      await Promise.all([refusal(tag("souvenir", rule, a)), refusal(tag("souvenir", rule, b))]),
    ).toEqual(["none", "none"]);
    expect(await tagsOf(rule)).toBe(1);
    const insert = (event: string, columns: string, values: string) =>
      f.db.owner.query(
        `INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, ${columns}, created_by)
         VALUES ($1, $2, $3, ${values}, $4)`,
        [f.ids.orgA, event, a, f.staff],
      );
    const fresh = await f.create();
    const refused = (columns: string, values: string, code: string) =>
      expect(insert(f.ids.eventA, columns, values)).rejects.toMatchObject({ code });
    await refused("souvenir_id", `'souvenir', '${rule}'`, "23505");
    await refused("souvenir_id", "'souvenir', NULL", "23514");
    await refused("souvenir_id, quest_id", `'souvenir', '${fresh}', '${f.quest}'`, "23514");
    await refused("souvenir_id", `'quest', '${fresh}'`, "23514");
    await refused("souvenir_id", `'badge', '${fresh}'`, "23514");
    await refused("souvenir_id", `'souvenir', '${foreignRule}'`, "23503");
  });

  it("takes the tag with a draft souvenir, keeps it with an active one, and answers a delete race as not found", async () => {
    const acme = await sponsor("Cascade");
    const draft = await f.create();
    await tag("souvenir", draft, acme);
    await f.run(f.actor, "SELECT souvenir_action($1, $2, 'delete', $3)", [
      f.ids.eventA,
      draft,
      randomUUID(),
    ]);
    expect(await tagsOf(draft)).toBe(0);
    const live = await f.create();
    await tag("souvenir", live, acme);
    await f.action(live);
    await expect(
      f.run(f.actor, "SELECT souvenir_action($1, $2, 'delete', $3)", [
        f.ids.eventA,
        live,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "SV409" });
    expect(await tagsOf(live)).toBe(1);

    const racing = await f.create();
    const [database] = (await f.db.owner.query("SELECT current_database() AS name")).rows;
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${database.name}`;
    const deleter = new Client({ connectionString: url.toString() });
    await deleter.connect();
    try {
      await deleter.query("BEGIN");
      await deleter.query("DELETE FROM souvenir_rule WHERE id = $1", [racing]);
      const pending = refusal(tag("souvenir", racing, acme));
      let waiting = false;
      for (let attempt = 0; attempt < 300 && !waiting; attempt += 1) {
        waiting =
          (
            await f.db.owner.query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%sponsor_tag_set%'",
            )
          ).rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await deleter.query("COMMIT");
      expect(await pending).toBe("SO404");
    } finally {
      await deleter.end();
    }
  });

  it("copies no souvenir tag into a duplicate of the event, and still copies the others", async () => {
    const acme = await sponsor("Copied");
    await tag("souvenir", await f.create(), acme);
    await tag("quest", f.quest, acme);
    const target = (
      await f.db.owner.query(
        `INSERT INTO event (organizer_id, join_code, name_en, starts_at, ends_at)
         VALUES ($1, 'SVCOPY', 'Copy', now() + interval '30 days', now() + interval '31 days') RETURNING id`,
        [f.ids.orgA],
      )
    ).rows[0].id as string;
    const counts = (
      await f.run(
        { ...f.actor, repeatableRead: true },
        "SELECT event_copy_setup($1, $2, $3) AS r",
        [f.ids.eventA, target, randomUUID()],
      )
    ).rows[0].r;
    expect(counts.sponsorTags).toBeGreaterThanOrEqual(1);
    const copied = (
      await f.db.owner.query("SELECT kind FROM sponsor_tag WHERE event_id = $1", [target])
    ).rows.map((row) => row.kind as string);
    expect(copied).toContain("quest");
    expect(copied).not.toContain("souvenir");
    const rules = await f.db.owner.query(
      "SELECT count(*)::int AS n FROM souvenir_rule WHERE event_id = $1",
      [target],
    );
    expect(rules.rows[0].n).toBe(0);
  });

  it("totals a sponsor's active and stopped souvenirs by how many players earned them", async () => {
    const fresh = (
      await f.db.owner.query(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'SVTOTAL', 'Totals', 'live', now() - interval '1 hour', now() + interval '3 days') RETURNING id`,
        [f.ids.orgA],
      )
    ).rows[0].id as string;
    const save = async (draft: Record<string, unknown>) =>
      (
        await f.run(f.actor, "SELECT sponsor_save($1, $2::jsonb, NULL, $3) AS r", [
          fresh,
          JSON.stringify(draft),
          randomUUID(),
        ])
      ).rows[0].r.id as string;
    const [rich, bare] = [
      await save({ nameEn: "Rich", tier: "gold" }),
      await save({ nameEn: "Bare", tier: "silver" }),
    ];
    const rules: string[] = [];
    for (const name of ["Gold frame", "Silver frame", "Draft frame"]) {
      const made = await f.run(f.actor, "SELECT souvenir_save($1, NULL, $2, $3) AS id", [
        fresh,
        { ...f.body, name: { ar: name, en: name } },
        randomUUID(),
      ]);
      rules.push(made.rows[0].id as string);
    }
    for (const rule of rules) await tag("souvenir", rule, rich, f.actor, fresh);
    const holder = (
      await f.db.owner.query("INSERT INTO player (username) VALUES ('totals_owner') RETURNING id")
    ).rows[0].id as string;
    const enrollment = (
      await f.db.owner.query(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [f.ids.orgA, fresh, holder],
      )
    ).rows[0].id as string;
    const act = (rule: string, verb: string) =>
      f.run(f.actor, "SELECT souvenir_action($1, $2, $3, $4)", [fresh, rule, verb, randomUUID()]);
    await act(rules[0] ?? "", "activate");
    await act(rules[1] ?? "", "activate");
    await f.run({}, "SELECT souvenir_evaluate($1)", [enrollment]);
    await act(rules[1] ?? "", "stop");
    const totals = (await f.run(f.actor, "SELECT analytics_sponsor($1, $2) AS r", [fresh, rich]))
      .rows[0].r;
    expect(sponsorRawSchema.safeParse(totals).success).toBe(true);
    expect(totals.souvenirs).toEqual([
      { id: rules[0], name: { ar: "Gold frame", en: "Gold frame" }, earned: 1 },
      { id: rules[1], name: { ar: "Silver frame", en: "Silver frame" }, earned: 1 },
    ]);
    const empty = (await f.run(f.actor, "SELECT analytics_sponsor($1, $2) AS r", [fresh, bare]))
      .rows[0].r;
    expect(empty.souvenirs).toEqual([]);
    expect(JSON.stringify(totals)).not.toContain(holder);
    const ask = (seat: RequestContext, sponsorId: string) =>
      refusal(f.run(seat, "SELECT analytics_sponsor($1, $2)", [fresh, sponsorId]));
    expect(await ask(f.actor, randomUUID())).toBe("AN404");
    expect(await ask(teamB, rich)).toBe("AN404");
  });

  it("keeps the new helper closed: no role can call it, only the owner's own reads do", async () => {
    const closed = await f.db.owner.query(
      `SELECT has_function_privilege('questify_app', 'souvenir_presented_by(uuid)', 'EXECUTE') AS app,
              has_function_privilege('questify_outsider', 'souvenir_presented_by(uuid)', 'EXECUTE') AS outsider,
              has_function_privilege('public', 'souvenir_presented_by(uuid)', 'EXECUTE') AS everyone`,
    );
    expect(closed.rows[0]).toEqual({ app: false, outsider: false, everyone: false });
    await expect(f.run(me(), "SELECT souvenir_presented_by($1)", [randomUUID()])).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      f.run(f.actor, "SELECT souvenir_presented_by($1)", [randomUUID()]),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps the tag when an owner is erased, and the other owners still see the label", async () => {
    const acme = await sponsor("Survives");
    const rule = await earned();
    await tag("souvenir", rule, acme);
    const second = (
      await f.db.owner.query("INSERT INTO player (username) VALUES ('second_owner') RETURNING id")
    ).rows[0].id as string;
    const enrollment = (
      await f.db.owner.query(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [f.ids.orgA, f.ids.eventA, second],
      )
    ).rows[0].id as string;
    await f.run({}, "SELECT souvenir_evaluate($1)", [enrollment]);
    const item = await itemOf(rule);
    const otherLabel = async () =>
      (await lockerOf({ playerId: second })).find((row) => row.item.id === item)?.presented_by;
    expect((await otherLabel())?.name.en).toBe("Survives");

    const hash = await f.deletion();
    await f.run({}, "SELECT * FROM erase_player($1, true, $2)", [hash, randomUUID()]);
    expect(
      (await f.db.owner.query("SELECT 1 FROM player_item WHERE player_id = $1", [f.ids.playerA]))
        .rows,
    ).toEqual([]);
    expect(await lockerOf()).toEqual([]);
    expect(await tagsOf(rule)).toBe(1);
    expect((await otherLabel())?.name.en).toBe("Survives");
    const recap = await recapOf({ playerId: second });
    expect(recap.find((entry) => entry.id === item)?.presentedBy?.name.en).toBe("Survives");
  });
});
