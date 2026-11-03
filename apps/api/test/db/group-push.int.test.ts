/* oxlint-disable unicorn/consistent-function-scoping -- each helper sits in the describe that uses it, beside its tests */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushMessageOf, type ClaimedSend } from "#src/push/message";
import { invitationFixture, type InvitationFixture } from "#test/support/invitations";
import { pushFixture, type PushFixture } from "#test/support/push";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Doc = Record<string, unknown>;
type Fan = Readonly<{ rows: number; more: boolean }>;

/** A call's SQLSTATE and detail ("CA400:body.en"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const TITLE = { ar: "عرض الأسبوع", en: "This week's offer" };
const BODY = { ar: "تحدٍّ جديد بانتظارك.", en: "A new challenge is waiting." };
const text = (over: Doc = {}): Doc => ({ title: TITLE, body: BODY, ...over });
const eventAudience = (code: string): Doc => ({ kind: "event", joinCode: code });
const promoAudience = (cityId: string | null = null, interests: string[] = []): Doc => ({
  kind: "promo",
  cityId,
  interests,
});
const draftOf = (audience: Doc, over: Doc = {}): Doc => ({ audience, ...text(over) });

/**
 * A push to a group of players in the database (T-706b, migration 0138; ADR-531 to ADR-534): every door is for an active
 * platform admin only (QE403); an event push is one notice the store fans out to the event's real members (a rehearsal
 * account, a left player and a non-member get nothing; a muted topic keeps the center row and loses the push); a
 * promotional push is written a page of 500 opted-in players at a time through `marketing_audience`, by city and
 * interests, the weekly cap shared with the invitations, and the consent read again at the fan-out and the claim.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("push to a group (database)", () => {
  let q: QuestifyFixture;
  let p: PushFixture;
  let iv: InvitationFixture;
  let admin: RequestContext = {};
  let adminId = "";
  let memberId = "";

  beforeAll(async () => {
    q = await questifyFixture();
    p = await pushFixture(q);
    iv = await invitationFixture(q);
    const [row] = await q.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('gp@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
    memberId = q.ownerA;
  });
  afterAll(async () => {
    await q.close();
  });
  beforeEach(async () => {
    await p.drain();
    // The platform holds sends to 20 an hour, and each test counts its own.
    await q.owner("DELETE FROM group_push");
  });

  const one = async <T>(sql: string, values: unknown[] = [], seat: RequestContext = admin) =>
    (await q.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const preview = (draft: Doc, seat: RequestContext = admin) =>
    one<Doc>("SELECT admin_group_push_preview($1) AS r", [draft], seat);
  const send = (draft: Doc, seat: RequestContext = admin) =>
    one<Doc>("SELECT admin_group_push_send($1, $2) AS r", [draft, randomUUID()], seat);
  const list = () => one<Doc[]>("SELECT admin_group_push_list() AS r");
  const fan = () => one<Fan>("SELECT group_push_fan() AS r", [], p.system);
  /** Pages the fan door until it says no more; answers the players it read. */
  const fanAll = async (): Promise<number> => {
    let rows = 0;
    for (let call = 0; call < 20; call += 1) {
      const page = await fan();
      rows += page.rows;
      if (!page.more) return rows;
    }
    throw new Error("the group push never finished");
  };
  const noticeIds = async (push: Doc): Promise<string[]> =>
    (
      await q.owner<{ id: string }>(
        "SELECT id FROM notice WHERE dedupe = $1 OR dedupe LIKE $1 || ':%' ORDER BY id",
        [`gpush:${push["id"]}`],
      )
    ).map((row) => row.id);
  /** The device sends of every notice a send wrote. */
  const sendsOf = (push: Doc) =>
    q.owner<{ state: string; code: string | null; player_id: string }>(
      `SELECT s.state, s.code, d.player_id FROM push_send s
       JOIN notice n ON n.id = s.notice_id JOIN push_device d ON d.id = s.device_id
       WHERE n.dedupe = $1 OR n.dedupe LIKE $1 || ':%' ORDER BY s.id`,
      [`gpush:${push["id"]}`],
    );
  const centerOf = async (push: Doc): Promise<string[]> =>
    (
      await q.owner<{ player_id: string }>(
        `SELECT c.player_id FROM notification c JOIN notice n ON n.id = c.notice_id
         WHERE n.dedupe = $1 OR n.dedupe LIKE $1 || ':%' ORDER BY c.player_id`,
        [`gpush:${push["id"]}`],
      )
    ).map((row) => row.player_id);
  const row = async (id: unknown) =>
    (await q.owner<Doc>("SELECT * FROM group_push WHERE id = $1", [id]))[0] as Doc;

  /** Turns every player's push consent off, so a promotional audience holds only the players a test makes. */
  const isolate = () =>
    q.owner(
      `INSERT INTO marketing_consent (player_id, channel, granted, method)
       SELECT s.player_id, 'push', false, 'settings' FROM marketing_state s WHERE s.channel = 'push' AND s.opted_in`,
    );
  /** `n` new adult players opted in to promotional push, in a city and holding interests (ids in username order). */
  const optedIn = async (
    n: number,
    where: Readonly<{ city?: string | null; interests?: string[] }> = {},
  ): Promise<string[]> => {
    const tag = randomUUID().slice(0, 8);
    const made = await q.owner<{ id: string }>(
      `INSERT INTO player (username, birth_year)
       SELECT 'gp_' || $1 || '_' || g, extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::integer - 30
       FROM generate_series(1, $2) g RETURNING id`,
      [tag, n],
    );
    const ids = made.map((one_) => one_.id);
    await q.owner(
      `INSERT INTO marketing_consent (player_id, channel, granted, method, text_version, language)
       SELECT id, 'push', true, 'settings', '1', 'en' FROM unnest($1::uuid[]) id`,
      [ids],
    );
    await q.owner(
      `INSERT INTO player_preference (player_id, city_id, interests)
       SELECT id, $2, $3::text[] FROM unnest($1::uuid[]) id`,
      [ids, where.city ?? null, where.interests ?? []],
    );
    return ids;
  };
  const optOut = (player: string) =>
    q.owner(
      "INSERT INTO marketing_consent (player_id, channel, granted, method) VALUES ($1, 'push', false, 'settings')",
      [player],
    );
  const codeOf = async (event: string) =>
    (await q.owner<{ join_code: string }>("SELECT join_code FROM event WHERE id = $1", [event]))[0]
      ?.join_code ?? "";
  /** A live event with `members` real players, each on a phone, and one rehearsal account. */
  const eventWithPlayers = async (phase: "scheduled" | "live" | "ended" = "live", members = 3) => {
    const event = await q.newEvent({ phase });
    const real: string[] = [];
    for (let i = 0; i < members; i += 1) {
      const player = await q.newPlayer();
      await q.join(event, player);
      await p.phone(player, { language: "en" });
      real.push(player);
    }
    const rehearsal = await q.newPlayer();
    await q.join(event, rehearsal, "rehearsal");
    await p.phone(rehearsal);
    return { event, code: await codeOf(event), real, rehearsal };
  };

  describe("who may call the doors", () => {
    it("refuses everyone but an active platform admin, and the fan door to everyone but the system seat", async () => {
      const [off] = await q.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('gp-off@questify.test', 'h', 'admin', 'disabled') RETURNING id",
      );
      const seats: RequestContext[] = [
        { staffUserId: memberId },
        { isAdmin: true, staffUserId: memberId },
        { isAdmin: true, staffUserId: off?.id ?? "" },
        { staffUserId: adminId },
        { playerId: await q.newPlayer() },
        {},
      ];
      const draft = draftOf(promoAudience());
      const calls: Array<[string, unknown[]]> = [
        ["SELECT admin_group_push_preview($1)", [draft]],
        ["SELECT admin_group_push_send($1, $2)", [draft, randomUUID()]],
        ["SELECT admin_group_push_list()", []],
      ];
      for (const seat of seats) {
        for (const [call, values] of calls) {
          expect(await refusal(q.run(seat, call, values)), `${call} ${JSON.stringify(seat)}`).toBe(
            "QE403",
          );
        }
      }
      for (const seat of [admin, { staffUserId: memberId }, { playerId: await q.newPlayer() }]) {
        expect(await refusal(q.run(seat, "SELECT group_push_fan()")), JSON.stringify(seat)).toBe(
          "PN403:system_only",
        );
      }
      expect(await q.owner("SELECT 1 FROM group_push")).toEqual([]);
      expect(await q.owner("SELECT 1 FROM audit_log WHERE target_type = 'group_push'")).toEqual([]);
    });
  });

  describe("a draft that breaks a rule", () => {
    it("is refused with the field named, by the preview and the send alike", async () => {
      const { code } = await eventWithPlayers();
      const cases: Array<[string, Doc]> = [
        ["GP400:audience", { ...text() }],
        ["GP400:audience", draftOf({ kind: "everyone" })],
        ["GP400:joinCode", draftOf({ kind: "event" })],
        ["GP404", draftOf(eventAudience("NOSUCH1"))],
        ["GP400:cityId", draftOf(promoAudience("sa-atlantis"))],
        ["GP400:interests", draftOf(promoAudience(null, ["sport", "sport"]))],
        ["GP400:interests", draftOf(promoAudience(null, ["not-a-topic"]))],
        ["GP400:interests", draftOf({ kind: "promo", cityId: null, interests: "sport" })],
        ["CA400:title.ar", draftOf(promoAudience(), { title: { ar: "", en: TITLE.en } })],
        [
          "CA400:title.en",
          draftOf(promoAudience(), { title: { ar: TITLE.ar, en: "x".repeat(61) } }),
        ],
        ["CA400:body.ar", draftOf(promoAudience(), { body: { ar: "x".repeat(141), en: BODY.en } })],
        ["CA400:body.en", draftOf(promoAudience(), { body: { ar: BODY.ar, en: "Hi {name}" } })],
        ["CA400:body.en", draftOf(promoAudience(), { body: { ar: BODY.ar, en: "Hi\u0007" } })],
        ["CA400:body.en", draftOf(promoAudience(), { body: { ar: BODY.ar, en: "Hi ‮" } })],
      ];
      for (const [expected, draft] of cases) {
        expect(await refusal(preview(draft)), JSON.stringify(draft)).toBe(expected);
        expect(await refusal(send(draft)), JSON.stringify(draft)).toBe(expected);
      }
      expect(await refusal(preview(draftOf(eventAudience(code))))).toBe("none");
      expect(await q.owner("SELECT 1 FROM group_push")).toEqual([]);
    });

    it("is refused for an event that cannot take a push: a draft, archived or suspended one", async () => {
      const draftEvent = await q.newEvent({ phase: "scheduled" });
      await q.owner("UPDATE event SET status = 'draft' WHERE id = $1", [draftEvent]);
      const archived = await q.newEvent({ phase: "archived" });
      const suspended = await q.newEvent({ phase: "live" });
      await q.owner(
        "UPDATE event SET suspended_at = now(), suspension_reason = 'reviewing a report' WHERE id = $1",
        [suspended],
      );
      for (const event of [draftEvent, archived, suspended]) {
        const draft = draftOf(eventAudience(await codeOf(event)));
        expect(await refusal(preview(draft))).toBe(
          event === suspended ? "GP409:event_suspended" : "GP409:event_not_open",
        );
        expect(await refusal(send(draft))).not.toBe("none");
      }
    });

    it("is refused when nobody would receive it", async () => {
      await isolate();
      expect(await refusal(send(draftOf(promoAudience())))).toBe("GP204");
      const empty = await q.newEvent({ phase: "live" });
      expect(await refusal(send(draftOf(eventAudience(await codeOf(empty)))))).toBe("GP204");
      const onlyTest = await q.newEvent({ phase: "live" });
      await q.join(onlyTest, await q.newPlayer(), "rehearsal");
      expect(await refusal(send(draftOf(eventAudience(await codeOf(onlyTest)))))).toBe("GP204");
    });
  });

  describe("a push to everyone in an event", () => {
    it("reaches the event's real players and no one else, and says so in the preview", async () => {
      const { event, code, real, rehearsal } = await eventWithPlayers("live", 3);
      const gone = await q.newPlayer();
      await q.join(event, gone);
      await q.owner(
        "UPDATE enrollment SET status = 'left' WHERE event_id = $1 AND player_id = $2",
        [event, gone],
      );
      const outsider = await q.newPlayer();
      await p.phone(outsider);

      const seen = await preview(draftOf(eventAudience(code)));
      expect(seen).toMatchObject({ audience: "event", reach: 3, capped: false });
      expect(seen["event"]).toMatchObject({ joinCode: code, status: "live" });

      const sent = await send(draftOf(eventAudience(code)));
      expect(sent).toMatchObject({
        audience: "event",
        state: "done",
        reach: 3,
        notices: 1,
        capped: 0,
      });
      expect(sent["event"]).toMatchObject({ id: event });
      await p.fanOut();
      expect(await centerOf(sent)).toEqual(real.toSorted());
      expect(await noticeIds(sent)).toHaveLength(1);
      expect(await sendsOf(sent)).toHaveLength(3);
      expect(await centerOf(sent)).not.toContain(rehearsal);
      expect(await centerOf(sent)).not.toContain(gone);
      expect(await centerOf(sent)).not.toContain(outsider);
    });

    it("sends the admin's text on the phone, in the player's language, and nothing of the player", async () => {
      const { code, real } = await eventWithPlayers("live", 1);
      const sent = await send(draftOf(eventAudience(code)));
      await p.fanOut();
      const [claimed] = await p.claim();
      expect(claimed).toBeDefined();
      const message = pushMessageOf(claimed as unknown as ClaimedSend);
      expect(message).toMatchObject({ title: TITLE.en, body: BODY.en });
      expect(JSON.stringify(message)).not.toContain(real[0] ?? "-");
      expect(message?.channel).toBe("announcements");
      expect(await centerOf(sent)).toEqual(real);
    });

    it("reaches the real players of a scheduled and of an ended event, never a rehearsal account", async () => {
      for (const phase of ["scheduled", "ended"] as const) {
        const { code, real, rehearsal } = await eventWithPlayers(phase, 2);
        const sent = await send(draftOf(eventAudience(code)));
        await p.fanOut();
        const reached = await centerOf(sent);
        expect(reached, phase).toEqual(real.toSorted());
        expect(reached, phase).not.toContain(rehearsal);
      }
    });

    it("keeps the center row of a player who muted announcements and sends them no push", async () => {
      const { code, real } = await eventWithPlayers("live", 2);
      await q.owner("INSERT INTO push_topic_mute (player_id, topic) VALUES ($1, 'announcements')", [
        real[0],
      ]);
      const sent = await send(draftOf(eventAudience(code)));
      await p.fanOut();
      expect(await centerOf(sent)).toEqual(real.toSorted());
      expect((await sendsOf(sent)).map((one_) => one_.player_id)).toEqual([real[1]]);
    });

    it("is written once per send: a second send is a second notice", async () => {
      const { code } = await eventWithPlayers("live", 1);
      const first = await send(draftOf(eventAudience(code)));
      const second = await send(draftOf(eventAudience(code)));
      expect(first["id"]).not.toBe(second["id"]);
      expect((await noticeIds(first)).length + (await noticeIds(second)).length).toBe(2);
    });
  });

  describe("a push to opted-in players", () => {
    it("reaches only the players who opted in, in the city and holding an interest asked for", async () => {
      await isolate();
      const riyadhMusic = await optedIn(2, { city: "sa-riyadh", interests: ["music"] });
      const riyadhSport = await optedIn(1, { city: "sa-riyadh", interests: ["sport"] });
      const jeddahMusic = await optedIn(1, { city: "sa-jeddah", interests: ["music"] });
      const noPlace = await optedIn(1);
      const refused = await optedIn(1, { city: "sa-riyadh", interests: ["music"] });
      await optOut(refused[0] ?? "");
      const neverAsked = await q.newPlayer();
      await q.owner("UPDATE player SET birth_year = 1990 WHERE id = $1", [neverAsked]);
      await q.owner(
        "INSERT INTO player_preference (player_id, city_id, interests) VALUES ($1, 'sa-riyadh', '{music}')",
        [neverAsked],
      );
      const minor = await optedIn(1, { city: "sa-riyadh", interests: ["music"] });
      await q.owner(
        "UPDATE player SET birth_year = extract(year FROM now())::integer - 15 WHERE id = $1",
        [minor[0]],
      );
      const banned = await optedIn(1, { city: "sa-riyadh", interests: ["music"] });
      await q.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned[0]]);

      expect(await preview(draftOf(promoAudience("sa-riyadh", ["music"])))).toMatchObject({
        audience: "promo",
        reach: 2,
        capped: false,
        event: null,
        cityId: "sa-riyadh",
      });
      expect(await preview(draftOf(promoAudience("sa-riyadh")))).toMatchObject({ reach: 3 });
      expect(await preview(draftOf(promoAudience(null, ["music", "sport"])))).toMatchObject({
        reach: 4,
      });
      expect(await preview(draftOf(promoAudience()))).toMatchObject({ reach: 5 });

      const sent = await send(draftOf(promoAudience("sa-riyadh", ["music"])));
      expect(sent).toMatchObject({ audience: "promo", state: "sending", reach: 2, notices: 0 });
      expect(await fanAll()).toBe(2);
      expect(await row(sent["id"])).toMatchObject({ state: "done", notices: 2, capped: 0 });
      await p.fanOut();
      expect(await centerOf(sent)).toEqual(riyadhMusic.toSorted());
      for (const other of [
        riyadhSport,
        jeddahMusic,
        noPlace,
        refused,
        [neverAsked],
        minor,
        banned,
      ]) {
        expect(await centerOf(sent)).not.toContain(other[0]);
      }
    });

    it("pushes only to a phone that is signed in, one send for the player, and no center row without consent", async () => {
      await isolate();
      const [withPhone, withoutPhone] = await optedIn(2, { city: "sa-taif" });
      await p.phone(withPhone ?? "", { language: "ar" });
      const sent = await send(draftOf(promoAudience("sa-taif")));
      await fanAll();
      await p.fanOut();
      expect((await centerOf(sent)).toSorted()).toEqual([withPhone, withoutPhone].toSorted());
      expect(await sendsOf(sent)).toEqual([{ state: "queued", code: null, player_id: withPhone }]);
      const [claimed] = await p.claim();
      expect(pushMessageOf(claimed as unknown as ClaimedSend)).toMatchObject({
        title: TITLE.ar,
        body: BODY.ar,
        channel: "offers",
        priority: "normal",
      });
    });

    it("reads the consent again at the fan-out and at the claim: an opt-out in between wins", async () => {
      await isolate();
      const [early, late, stays] = await optedIn(3, { city: "sa-abha" });
      for (const player of [early, late, stays]) await p.phone(player ?? "");
      const sent = await send(draftOf(promoAudience("sa-abha")));
      await fanAll();
      expect((await noticeIds(sent)).length).toBe(3);
      await optOut(early ?? "");
      await p.fanOut();
      expect(await centerOf(sent)).toEqual([late, stays].toSorted());
      await optOut(late ?? "");
      const claimed = await p.claim();
      expect(claimed.map((one_) => one_.token)).toHaveLength(1);
      const states = await sendsOf(sent);
      expect(states.map((one_) => one_.state).toSorted()).toEqual(["sending", "skipped"]);
      expect(states.find((one_) => one_.state === "skipped")).toMatchObject({
        code: "consent",
        player_id: late,
      });
    });

    it("pages 500 players at a time, in player order, and is done when a page comes back short", async () => {
      await isolate();
      const players = await optedIn(1203, { city: "sa-yanbu" });
      const sent = await send(draftOf(promoAudience("sa-yanbu")));
      expect(sent["reach"]).toBe(1203);
      expect(await fan()).toEqual({ rows: 500, more: true });
      expect(await row(sent["id"])).toMatchObject({ state: "sending", notices: 500 });
      expect(await fan()).toEqual({ rows: 500, more: true });
      expect(await fan()).toEqual({ rows: 203, more: false });
      expect(await row(sent["id"])).toMatchObject({ state: "done", notices: 1203, capped: 0 });
      expect(await fan()).toEqual({ rows: 0, more: false });
      const noticed = await q.owner<{ player_id: string }>(
        "SELECT player_id FROM notice WHERE dedupe LIKE $1 || ':%'",
        [`gpush:${sent["id"]}`],
      );
      expect(new Set(noticed.map((one_) => one_.player_id))).toEqual(new Set(players));
    });

    it("runs the oldest send first and leaves a later one waiting", async () => {
      await isolate();
      await optedIn(2, { city: "sa-tabuk" });
      await optedIn(2, { city: "sa-hail" });
      const first = await send(draftOf(promoAudience("sa-tabuk")));
      const second = await send(draftOf(promoAudience("sa-hail")));
      expect(await fan()).toEqual({ rows: 2, more: false });
      expect(await row(first["id"])).toMatchObject({ state: "done" });
      expect(await row(second["id"])).toMatchObject({ state: "sending", notices: 0 });
      expect(await fan()).toEqual({ rows: 2, more: false });
      expect(await row(second["id"])).toMatchObject({ state: "done", notices: 2 });
    });

    it("erases with the player: no notice or center row is left for an erased player", async () => {
      await isolate();
      const [gone, kept] = await optedIn(2, { city: "sa-najran" });
      const sent = await send(draftOf(promoAudience("sa-najran")));
      await fanAll();
      await p.fanOut();
      expect(await p.erase(gone ?? "")).toBeDefined();
      expect(await centerOf(sent)).toEqual([kept]);
      const left = await q.owner("SELECT 1 FROM notice WHERE player_id = $1", [gone]);
      expect(left).toEqual([]);
    });
  });

  describe("the weekly cap (Q-421, ADR-534)", () => {
    it("leaves out a player told by a group push in the last 7 days, and counts them", async () => {
      await isolate();
      const [told, fresh] = await optedIn(2, { city: "sa-jazan" });
      const first = await send(draftOf(promoAudience("sa-jazan")));
      await fanAll();
      expect(await row(first["id"])).toMatchObject({ notices: 2, capped: 0 });

      expect(await preview(draftOf(promoAudience("sa-jazan")))).toMatchObject({ reach: 0 });
      expect(await refusal(send(draftOf(promoAudience("sa-jazan"))))).toBe("GP204");

      await q.owner(
        `UPDATE notice SET created_at = now() - interval '6 days' WHERE player_id = $1 AND kind = 'group_push_promo'`,
        [fresh],
      );
      await q.owner(
        `UPDATE notice SET created_at = now() - interval '8 days' WHERE player_id = $1 AND kind = 'group_push_promo'`,
        [told],
      );
      const second = await send(draftOf(promoAudience("sa-jazan")));
      expect(second["reach"]).toBe(1);
      await fanAll();
      expect(await row(second["id"])).toMatchObject({ notices: 1, capped: 1 });
      expect(
        await q.owner<{ player_id: string }>(
          "SELECT player_id FROM notice WHERE dedupe LIKE $1 || ':%'",
          [`gpush:${second["id"]}`],
        ),
      ).toEqual([{ player_id: told }]);
    });

    it("counts a player the cap leaves out between the preview and the page", async () => {
      await isolate();
      const [told, other] = await optedIn(2, { city: "sa-khobar" });
      const sent = await send(draftOf(promoAudience("sa-khobar")));
      await q.owner(
        `INSERT INTO notice (kind, player_id, audience, dedupe, expires_at, fanned_at)
         VALUES ('group_push_promo', $1::uuid, 'player', 'earlier:' || $1::text, now() + interval '1 day', now())`,
        [told],
      );
      await fanAll();
      expect(await row(sent["id"])).toMatchObject({ notices: 1, capped: 1 });
      const written = await q.owner<{ player_id: string }>(
        "SELECT player_id FROM notice WHERE dedupe LIKE $1 || ':%'",
        [`gpush:${sent["id"]}`],
      );
      expect(written.map((one_) => one_.player_id)).toEqual([other]);
    });

    it("leaves out a player with an invitation by push queued, or sent or unknown in the last 7 days", async () => {
      await iv.reset();
      await iv.switchOn();
      await isolate();
      const players = await optedIn(50, { city: "sa-buraidah" });
      for (const player of players) await p.phone(player);
      const event = await iv.eligibleEvent();
      const campaign = (await iv.request(event)).id;
      await iv.approve(campaign, { channels: ["push"] });
      expect(await iv.startDue()).toBe("started");
      const audience = draftOf(promoAudience("sa-buraidah"));
      expect(await preview(audience)).toMatchObject({ reach: 0 });

      const [oldSent, recentSent, unknown, failed, skipped] = (await iv.recipients(campaign)).map(
        (one_) => one_.id,
      );
      const set = (id: string | undefined, state: string, extra: string) =>
        q.owner(`UPDATE invitation_recipient SET state = $2, ${extra} WHERE id = $1`, [id, state]);
      await set(oldSent, "sent", "sent_at = now() - interval '8 days'");
      await set(recentSent, "sent", "sent_at = now() - interval '6 days'");
      await set(unknown, "unknown", "sent_at = now() - interval '1 day'");
      await set(failed, "failed", "error_code = 'M0001'");
      await set(skipped, "skipped", "skip_reason = 'opted_out'");
      expect(await preview(audience)).toMatchObject({ reach: 3 });
    });
  });

  describe("what the table and the list keep", () => {
    it("lists the last sends, newest first, with their audience, text and counts", async () => {
      await isolate();
      await optedIn(1, { city: "sa-alula" });
      const { code } = await eventWithPlayers("live", 1);
      const eventPush = await send(draftOf(eventAudience(code)));
      const promoPush = await send(draftOf(promoAudience("sa-alula")));
      const rows = await list();
      expect(rows.map((one_) => one_["id"])).toEqual([promoPush["id"], eventPush["id"]]);
      expect(rows[1]).toMatchObject({
        audience: "event",
        state: "done",
        title: TITLE,
        body: BODY,
        notices: 1,
        capped: 0,
        reach: 1,
      });
      expect(rows[1]?.["event"]).toMatchObject({ joinCode: code });
      expect(rows[0]).toMatchObject({
        audience: "promo",
        state: "sending",
        cityId: "sa-alula",
        event: null,
      });
    });

    it("lists no more than the last 50", async () => {
      await q.owner(
        `INSERT INTO group_push (audience, title_ar, title_en, body_ar, body_en, state, reach, created_by, finished_at,
                                created_at)
         SELECT 'promo', 'عنوان', 'Title', 'نص', 'Body', 'done', 1, $1, now() - interval '2 hours',
                now() - interval '2 hours' - g * interval '1 minute'
         FROM generate_series(1, 55) g`,
        [adminId],
      );
      expect(await list()).toHaveLength(50);
    });

    it("audits each send in the admin's name, with the audience and the reach and not the text", async () => {
      const { code, event } = await eventWithPlayers("live", 2);
      const sent = await send(draftOf(eventAudience(code)));
      const audits = await q.owner<{ actor_id: string; action: string; after: Doc }>(
        "SELECT actor_id, action, after FROM audit_log WHERE target_type = 'group_push' AND target_id = $1",
        [sent["id"]],
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor_id: adminId,
        action: "group_push.send",
        after: { audience: "event", eventId: event, cityId: null, interests: [], reach: 2 },
      });
      expect(JSON.stringify(audits[0]?.after)).not.toContain(TITLE.en);
    });

    it("freezes the audience and the text, and a finished send, even for the owner", async () => {
      await isolate();
      await optedIn(1, { city: "sa-alula" });
      const sent = await send(draftOf(promoAudience("sa-alula")));
      for (const change of [
        "title_en = 'Changed'",
        "body_ar = 'تغيير'",
        "city_id = 'sa-riyadh'",
        "interests = '{music}'",
        "reach = 99",
      ]) {
        expect(
          await refusal(q.owner(`UPDATE group_push SET ${change} WHERE id = $1`, [sent["id"]])),
          change,
        ).toBe("GP409:frozen");
      }
      await fanAll();
      expect(
        await refusal(q.owner("UPDATE group_push SET notices = 0 WHERE id = $1", [sent["id"]])),
      ).toBe("GP409:finished");
    });

    it("holds the platform to 20 sends an hour", async () => {
      await isolate();
      await optedIn(1, { city: "sa-hail" });
      const insert = (n: number) =>
        q.owner(
          `INSERT INTO group_push (audience, title_ar, title_en, body_ar, body_en, state, reach, created_by, finished_at)
           SELECT 'promo', 'عنوان', 'Title', 'نص', 'Body', 'done', 1, $1, now() FROM generate_series(1, $2)`,
          [adminId, n],
        );
      await insert(19);
      expect(await refusal(send(draftOf(promoAudience("sa-hail"))))).toBe("none");
      await insert(1);
      expect(await refusal(send(draftOf(promoAudience("sa-hail"))))).toBe("GP429");
    });
  });

  describe("the invitations' side of the cap", () => {
    it("does not invite by push a player a group push told in the last 7 days, and does again after", async () => {
      await iv.reset();
      await isolate();
      const players = await optedIn(52, { city: "sa-dhahran" });
      for (const player of players) await p.phone(player);
      const told = players[0] ?? "";
      await q.owner(
        `INSERT INTO notice (kind, player_id, audience, dedupe, expires_at, fanned_at)
         VALUES ('group_push_promo', $1::uuid, 'player', 'cap-test:' || $1::text, now() + interval '1 day', now())`,
        [told],
      );
      const event = await iv.eligibleEvent();
      const campaign = (await iv.request(event)).id;
      await iv.approve(campaign, { channels: ["push"] });
      const candidates = () =>
        q.owner<{ player_id: string; channel: string }>(
          "SELECT player_id, channel FROM invitation_candidates($1)",
          [campaign],
        );
      const picked = (await candidates()).map((pick) => pick.player_id);
      expect(picked).toHaveLength(51);
      expect(picked).not.toContain(told);

      await q.owner(
        "UPDATE notice SET created_at = now() - interval '8 days' WHERE dedupe = 'cap-test:' || $1::text",
        [told],
      );
      const later = await candidates();
      expect(later).toHaveLength(52);
      expect(later.every((pick) => pick.channel === "push")).toBe(true);
    });
  });
});
