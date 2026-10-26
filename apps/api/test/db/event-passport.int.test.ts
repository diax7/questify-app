import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { readEvents } from "#src/questify/questify";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Profile = { passport: Record<string, unknown>[]; achievements: unknown[] } & Record<
  string,
  unknown
>;
type EventRow = {
  event_id: string;
  played: boolean;
  member_status: string;
  rank: number | null;
  rank_state: string;
  is_public: boolean;
  city: { ar: string; en: string } | null;
  local_date: string;
};

/**
 * The Event Passport, the owner's history, the public profile's stamps and the event city (T-403, migration 0065,
 * ADR-275 to ADR-277): what counts as played, rank states, the public rule (MAJOR-1, MINOR-5) and the city guard.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event passport and history (database)", () => {
  let f: QuestifyFixture;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const events = (player: string, played: boolean) =>
    f.asPlayer<EventRow>(player, "SELECT * FROM own_events($1, NULL, NULL, 50)", [played]);
  const stamps = async (player: string) => (await events(player, true)).map((row) => row.event_id);
  const profileOf = async (player: string, viewer: string) =>
    (
      await f.asPlayer<{ p: Profile | null }>(viewer, "SELECT public_player_profile($1) AS p", [
        await f.usernameOf(player),
      ])
    )[0]?.p;

  it("makes one stamp from the first credit; repeats, welcome-only and empty memberships make none", async () => {
    const player = await f.newPlayer();
    const played = await f.newEvent();
    await f.play(played, player, 2);
    const welcomed = await f.newEvent();
    const enrollment = await f.join(welcomed, player);
    await f.owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
       VALUES ($1, $2, $3, 'welcome', 5, 5, 'system')`,
      [f.ids.orgA, welcomed, enrollment],
    );
    const empty = await f.newEvent();
    await f.join(empty, player);
    expect(await stamps(player)).toEqual([played]);
    const history = await events(player, false);
    expect(history.map((row) => [row.event_id, row.played])).toEqual(
      expect.arrayContaining([
        [played, true],
        [welcomed, false],
        [empty, false],
      ]),
    );
    expect(history).toHaveLength(3);
  });

  it("counts an operator's scan and drops a fully reversed event but keeps a partly reversed one", async () => {
    const player = await f.newPlayer();
    const scanned = await f.newEvent({ startedDaysAgo: 5 });
    await f.earn(scanned, await f.join(scanned, player), { operator: f.ownerA });
    const reversed = await f.newEvent({ startedDaysAgo: 4 });
    const lost = await f.earn(reversed, await f.join(reversed, player));
    await f.removeEntry(reversed, lost);
    const partly = await f.newEvent({ startedDaysAgo: 3 });
    const kept = await f.join(partly, player);
    await f.earn(partly, kept);
    await f.removeEntry(partly, await f.earn(partly, kept));
    expect(await stamps(player)).toEqual([partly, scanned]);
  });

  it("drops banned and removed memberships from the passport but keeps them, unplayed, in the history", async () => {
    const player = await f.newPlayer();
    const kinds: Record<string, string> = {};
    for (const status of ["banned", "removed", "left"]) {
      const event = await f.newEvent();
      kinds[event] = status;
      const enrollment = await f.play(event, player);
      await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [enrollment, status]);
    }
    const pending = await f.newEvent();
    const asked = await f.join(pending, player);
    await f.owner("UPDATE enrollment SET status = 'pending' WHERE id = $1", [asked]);
    const history = await events(player, false);
    expect(
      Object.fromEntries(
        history.map((row) => [kinds[row.event_id], [row.member_status, row.played]]),
      ),
    ).toEqual({
      banned: ["banned", false],
      removed: ["removed", false],
      left: ["left", true],
    });
    expect(await stamps(player)).toHaveLength(1);
  });

  it("never lists a rehearsal membership", async () => {
    const player = await f.newPlayer();
    const event = await f.newEvent({ phase: "scheduled" });
    await f.join(event, player, "rehearsal");
    expect(await events(player, false)).toEqual([]);
  });

  it("orders by event start, newest first, and pages on (start, id) with equal starts", async () => {
    const player = await f.newPlayer();
    const made: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const event = await f.newEvent();
      await f.play(event, player);
      made.push(event);
    }
    await f.owner(
      "UPDATE event SET starts_at = '2026-01-10T10:00:00.123456Z', ends_at = '2026-01-10T20:00:00Z' WHERE id = ANY($1)",
      [made.slice(0, 3)],
    );
    await f.owner(
      "UPDATE event SET starts_at = '2026-01-09T10:00:00Z', ends_at = '2026-01-09T20:00:00Z' WHERE id = $1",
      [made[3]],
    );
    const client = await f.pool.connect();
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await withRequestContext(client, { playerId: player }, () =>
          readEvents(client, { played: true, cursor, limit: 1 }),
        );
        seen.push(...page.events.map((row) => row.eventId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual([...made.slice(0, 3).toSorted().toReversed(), made[3]]);
      const [first] = (
        await withRequestContext(client, { playerId: player }, () =>
          readEvents(client, { played: true, limit: 50 }),
        )
      ).events;
      expect(first).toMatchObject({
        date: "2026-01-10",
        timezone: "Asia/Riyadh",
        score: 10,
        played: true,
      });
    } finally {
      client.release();
    }
  });

  it("moves the rank from live to pending to final, and shows unranked when there is no place", async () => {
    const player = await f.newPlayer();
    const left = await f.newPlayer();
    const event = await f.newEvent({ phase: "live", cityId: "sa-dammam" });
    await f.play(event, player);
    const gone = await f.play(event, left);
    const stateOf = async (who: string) => {
      const [row] = await events(who, true);
      return [row?.rank_state, row?.rank];
    };
    expect(await stateOf(player)).toEqual(["live", null]);
    await f.owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [event]);
    await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [gone]);
    expect(await stateOf(player)).toEqual(["pending", null]);
    expect(await f.confirm(event)).toBe("confirmed");
    expect(await stateOf(player)).toEqual(["pending", null]);
    expect(await f.reveal(event)).toBe("revealed");
    expect(await stateOf(player)).toEqual(["final", 1]);
    expect(await stateOf(left)).toEqual(["unranked", null]);
    const [row] = await events(player, true);
    expect(row?.city).toEqual({ ar: "الدمام", en: "Dammam" });
  });

  it("shows other players only ended public non-workplace stamps, with exactly the allowlisted keys", async () => {
    const player = await f.newPlayer();
    const viewer = await f.newPlayer();
    const make = async (
      name: string,
      options: Parameters<QuestifyFixture["newEvent"]>[0],
      days: number,
    ) => {
      const event = await f.newEvent({ ...options, startedDaysAgo: days });
      await f.play(event, player);
      return [name, event] as const;
    };
    const all = Object.fromEntries([
      await make("public", { cityId: "sa-riyadh" }, 9),
      await make("private", { access: "private" }, 8),
      await make("unlisted", { access: "unlisted" }, 7),
      await make("workplace", { kind: "workplace" }, 6),
      await make("live", { phase: "live" }, 5),
      await make("archived", { phase: "archived" }, 4),
    ]) as Record<"public" | "private" | "unlisted" | "workplace" | "live" | "archived", string>;
    const profile = await profileOf(player, viewer);
    expect(Object.keys(profile ?? {}).toSorted()).toEqual([
      "achievements",
      "character",
      "frame",
      "level",
      "passport",
      "title",
      "username",
    ]);
    const passport = profile?.passport as Record<string, unknown>[];
    expect(passport.map((stamp) => Object.keys(stamp).toSorted())).toEqual([
      ["city", "date", "name", "rank"],
      ["city", "date", "name", "rank"],
    ]);
    expect(passport[1]).toMatchObject({ city: { ar: "الرياض", en: "Riyadh" }, rank: null });
    expect(profile?.achievements).toEqual([
      { id: "events-attended", tier: null },
      { id: "quests-done", tier: null },
      { id: "cities-played", tier: null },
      { id: "top-ten", tier: null },
      { id: "community-goals", tier: null },
    ]);
    const body = JSON.stringify(profile);
    for (const id of Object.values(all)) expect(body).not.toContain(id);
    const flags = Object.fromEntries(
      (await events(player, true)).map((row) => [row.event_id, row.is_public]),
    );
    expect(flags).toEqual({
      [all.public ?? ""]: true,
      [all.private ?? ""]: false,
      [all.unlisted ?? ""]: false,
      [all.workplace ?? ""]: false,
      [all.live ?? ""]: false,
      [all.archived ?? ""]: true,
    });

    await f.owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [
      all.live,
    ]);
    await f.owner("UPDATE event SET access = 'private' WHERE id = $1", [all.public]);
    await f.sync(player);
    const later = await profileOf(player, viewer);
    expect(later?.passport).toHaveLength(2);
    expect(JSON.stringify(later?.passport)).not.toContain("الرياض");
    expect(later?.achievements).toContainEqual({ id: "events-attended", tier: "silver" });
  });

  it("never shows one player's memberships to another", async () => {
    const player = await f.newPlayer();
    const other = await f.newPlayer();
    await f.play(await f.newEvent(), player);
    expect(await events(other, false)).toEqual([]);
    expect(await f.run({}, "SELECT * FROM own_events(false, NULL, NULL, 50)")).toEqual([]);
  });

  it("guards the event city: none for virtual, only known cities, fixed once live, and only inside the caller's events", async () => {
    await expect(f.newEvent({ kind: "virtual", cityId: "sa-riyadh" })).rejects.toMatchObject({
      code: "23514",
      constraint: "event_virtual_no_city",
    });
    await expect(f.newEvent({ cityId: "sa-nowhere" })).rejects.toMatchObject({ code: "23503" });
    const scheduled = await f.newEvent({ phase: "scheduled" });
    const setCity = (event: string, city: string | null, staff = f.ownerA) =>
      f.run(f.team(staff), "UPDATE event SET city_id = $2 WHERE id = $1 RETURNING city_id", [
        event,
        city,
      ]);
    expect(await setCity(scheduled, "sa-jeddah")).toEqual([{ city_id: "sa-jeddah" }]);
    for (const phase of ["live", "ended", "archived"] as const) {
      const event = await f.newEvent({ phase, cityId: "sa-riyadh" });
      await expect(setCity(event, "sa-jeddah")).rejects.toMatchObject({ code: "CY409" });
      await expect(setCity(event, null)).rejects.toMatchObject({ code: "CY409" });
      expect(await setCity(event, "sa-riyadh")).toEqual([{ city_id: "sa-riyadh" }]);
      await expect(
        f.owner("UPDATE event SET city_id = 'sa-abha' WHERE id = $1", [event]),
      ).rejects.toMatchObject({
        code: "CY409",
      });
    }
    const other = await f.newEvent({ phase: "scheduled" });
    const limited = await addMember(f.db.owner, f.ids.orgA, "editor", [other]);
    expect(await setCity(scheduled, "sa-abha", limited)).toEqual([]);
    expect(await setCity(other, "sa-abha", limited)).toEqual([{ city_id: "sa-abha" }]);
    expect(await f.run({}, "SELECT city_list() AS list")).toEqual([
      { list: expect.arrayContaining([{ id: "sa-riyadh", name: { ar: "الرياض", en: "Riyadh" } }]) },
    ]);
  });
});
