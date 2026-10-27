import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refusal } from "#test/support/daily";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Channel = "push" | "sms" | "email";
type Own = {
  channels: Record<Channel, { optedIn: boolean; changedAt: string | null }>;
  asked: boolean;
  canOptIn: boolean;
};
type LogRow = { channel: Channel; granted: boolean; method: string; text_version: string | null };

/**
 * Marketing consent, preferences and "For you" in the database (T-407, migration 0070; FR-733 to FR-737, FR-1111,
 * FR-1113, FR-1114): default off, the first answer recorded, change-only logging, the age rule, an append-only log the
 * state follows, the opt-out link's door, the promotional audience, preferences, event interests, the recommendation
 * list and erasure.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("marketing and preferences (database)", () => {
  let f: QuestifyFixture;
  let admin: string;
  beforeAll(async () => {
    f = await questifyFixture();
    const [staff] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('mk@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = staff?.id ?? "";
  });
  afterAll(async () => {
    await f.close();
  });

  const year = async (): Promise<number> =>
    Number(
      (
        await f.owner<{ y: string }>(
          "SELECT extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::int AS y",
        )
      )[0]?.y,
    );
  /** A new active player; `age` is the difference between this year and the birth year (default 25). */
  const player = async (age: number | null = 25): Promise<string> => {
    const id = await f.newPlayer();
    await f.owner("UPDATE player SET birth_year = $2 WHERE id = $1", [
      id,
      age === null ? null : (await year()) - age,
    ]);
    return id;
  };
  const call = async <T>(who: string, sql: string, values: unknown[] = []): Promise<T> =>
    (await f.asPlayer<{ r: T }>(who, sql, values))[0]?.r as T;
  const set = (who: string, channels: object, how = "settings", version = "1") =>
    call<Own>(who, "SELECT set_marketing($1::jsonb, $2, $3) AS r", [
      JSON.stringify(channels),
      how,
      version,
    ]);
  const own = (who: string) => call<Own>(who, "SELECT own_marketing() AS r");
  const log = (who: string) =>
    f.owner<LogRow>(
      "SELECT channel, granted, method, text_version FROM marketing_consent WHERE player_id = $1 ORDER BY id",
      [who],
    );
  const count = async (sql: string, values: unknown[] = []) =>
    Number((await f.owner<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`, values))[0]?.n);
  const audience = async (ch: string, city: string | null, any: string[] | null = null) =>
    (
      await f.owner<{ player_id: string }>(
        "SELECT player_id FROM marketing_audience($1, $2, $3, NULL, 1000)",
        [ch, city, any],
      )
    ).map((row) => row.player_id);

  let phones = 0;
  /** A unique Saudi mobile number on the player's contact row (the fixture's players have an email only). */
  const givePhone = async (who: string) => {
    phones += 1;
    await f.owner("UPDATE player_contact SET phone_e164 = $2 WHERE player_id = $1", [
      who,
      `+9665${String(phones).padStart(8, "0")}`,
    ]);
  };

  const languageOf = async (who: string) =>
    (
      await f.owner<{ log: string | null; state: string | null }>(
        `SELECT (SELECT m.language FROM marketing_consent m WHERE m.player_id = $1 ORDER BY m.id DESC LIMIT 1) AS log,
                  (SELECT s.language FROM marketing_state s WHERE s.player_id = $1 AND s.channel = 'sms') AS state`,
        [who],
      )
    )[0];

  const optOut = async (who: string, channel: string) =>
    (await f.owner<{ r: string }>("SELECT marketing_opt_out($1, $2) AS r", [who, channel]))[0]?.r;

  const seat = () => ({ isAdmin: true, staffUserId: admin });
  const readConsent = (target: string) =>
    f.run<{ r: { channels: Record<Channel, { optedIn: boolean }>; history: unknown[] } }>(
      seat(),
      "SELECT marketing_consent_history($1, $2) AS r",
      [target, randomUUID()],
    );

  const save = (who: string, city: string | null, interests: string[]) =>
    call<{ cityId: string | null; interests: string[] }>(
      who,
      "SELECT set_preferences($1, $2::text[]) AS r",
      [city, interests],
    );

  const setEvent = (event: string, interests: string[]) =>
    f.run(f.team(), "UPDATE event SET interests = $2::text[] WHERE id = $1", [event, interests]);
  const readEventInterests = async (event: string) =>
    (
      await f.owner<{ interests: string[] }>("SELECT interests FROM event WHERE id = $1", [event])
    )[0]?.interests;

  const forYou = async (who: string) =>
    call<{ id: string; city: { en: string } | null; interests: string[]; statusNow: string }[]>(
      who,
      "SELECT own_for_you() AS r",
    );
  const tagged = async (
    options: Parameters<QuestifyFixture["newEvent"]>[0],
    interests: string[],
    joinMethods = "{code,qr,link,public_list}",
  ): Promise<string> => {
    const event = await f.newEvent(options);
    await f.owner(
      "UPDATE event SET interests = $2::text[], join_methods = $3::text[] WHERE id = $1",
      [event, interests, joinMethods],
    );
    return event;
  };

  describe("consent", () => {
    it("starts off on every channel, unasked", async () => {
      const who = await player();
      expect(await own(who)).toMatchObject({
        channels: {
          push: { optedIn: false, changedAt: null },
          sms: { optedIn: false, changedAt: null },
          email: { optedIn: false, changedAt: null },
        },
        asked: false,
        canOptIn: true,
      });
      expect(await log(who)).toEqual([]);
    });

    it("records a skipped step as three dated opt-outs, once", async () => {
      const who = await player();
      const answer = await set(who, { push: false, sms: false, email: false }, "signup");
      expect(answer.asked).toBe(true);
      expect(Object.values(answer.channels).every((c) => !c.optedIn && c.changedAt !== null)).toBe(
        true,
      );
      expect(await log(who)).toEqual([
        { channel: "email", granted: false, method: "signup", text_version: null },
        { channel: "push", granted: false, method: "signup", text_version: null },
        { channel: "sms", granted: false, method: "signup", text_version: null },
      ]);
      await set(who, { push: false, sms: false, email: false }, "signup");
      expect(await count("marketing_consent WHERE player_id = $1", [who])).toBe(3);
    });

    it("records each change with its channel, method and text version, and only changes", async () => {
      const who = await player();
      await set(who, { sms: true }, "signup");
      expect(await log(who)).toEqual([
        { channel: "sms", granted: true, method: "signup", text_version: "1" },
      ]);
      expect((await own(who)).channels.sms.optedIn).toBe(true);
      expect((await own(who)).channels.push.optedIn).toBe(false);
      await set(who, { sms: true, email: true });
      expect((await log(who)).map((row) => `${row.channel}:${row.granted}:${row.method}`)).toEqual([
        "sms:true:signup",
        "email:true:settings",
      ]);
      await set(who, { sms: false });
      expect((await log(who)).at(-1)).toEqual({
        channel: "sms",
        granted: false,
        method: "settings",
        text_version: null,
      });
      expect((await own(who)).channels).toMatchObject({
        sms: { optedIn: false },
        email: { optedIn: true },
      });
    });

    it("refuses a turn-on by a possible minor, and still lets them turn things off", async () => {
      for (const age of [13, 17, 18]) {
        const who = await player(age);
        expect((await own(who)).canOptIn, `age gap ${age}`).toBe(false);
        expect(await refusal(set(who, { sms: true })), `age gap ${age}`).toBe("MK403:age");
        expect(await count("marketing_consent WHERE player_id = $1", [who])).toBe(0);
        expect((await set(who, { sms: false, push: false })).asked).toBe(true);
      }
      expect((await own(await player(19))).canOptIn).toBe(true);
      expect((await set(await player(19), { sms: true })).channels.sms.optedIn).toBe(true);
      expect(await refusal(set(await player(null), { email: true }))).toBe("MK403:age");
    });

    it("keeps an opt-in made before the player could no longer opt in, and lets it be withdrawn", async () => {
      const who = await player();
      await set(who, { push: true });
      await f.owner("UPDATE player SET birth_year = $2 WHERE id = $1", [who, (await year()) - 17]);
      expect((await set(who, { push: true })).channels.push.optedIn).toBe(true);
      expect((await set(who, { push: false })).channels.push.optedIn).toBe(false);
    });

    it("refuses a bad body and writes nothing", async () => {
      const who = await player();
      const bad: [string, object, string, string][] = [
        ["unknown channel", { fax: true }, "settings", "MK422:channels"],
        ["string value", { sms: "yes" }, "settings", "MK422:channels"],
        ["null value", { sms: null }, "settings", "MK422:channels"],
        ["no channel", {}, "settings", "MK422:channels"],
        ["mixed good and bad", { sms: true, fax: true }, "settings", "MK422:channels"],
        ["opt-out link method", { sms: false }, "opt_out_link", "MK422:method"],
        ["unknown method", { sms: false }, "admin", "MK422:method"],
      ];
      for (const [name, channels, how, expected] of bad) {
        expect(await refusal(set(who, channels, how)), name).toBe(expected);
      }
      expect(await refusal(set(who, { sms: true }, "settings", "v1"))).toBe("MK422:textVersion");
      expect(
        await refusal(call(who, "SELECT set_marketing('[]'::jsonb, 'settings', '1') AS r")),
      ).toBe("MK422:channels");
      expect(await count("marketing_consent WHERE player_id = $1", [who])).toBe(0);
    });

    it("answers 401-shaped for a caller who is not an active player", async () => {
      const gone = await player();
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [gone]);
      expect(await refusal(own(gone))).toBe("PI401");
      expect(await refusal(set(gone, { sms: false }))).toBe("PI401");
      expect(await refusal(call(randomUUID(), "SELECT own_marketing() AS r"))).toBe("PI401");
    });

    it("never lets one player's answers touch another's", async () => {
      const mine = await player();
      const theirs = await player();
      await set(mine, { sms: true, push: true });
      await set(theirs, { email: true });
      await set(mine, { sms: false });
      expect((await own(theirs)).channels).toMatchObject({
        sms: { optedIn: false },
        push: { optedIn: false },
        email: { optedIn: true },
      });
      expect(await log(theirs)).toHaveLength(1);
      expect((await own(mine)).channels).toMatchObject({
        sms: { optedIn: false },
        push: { optedIn: true },
        email: { optedIn: false },
      });
    });

    it("keeps the log append-only for every role, and the state equal to the log's last word", async () => {
      const who = await player();
      await set(who, { email: true });
      await set(who, { email: false });
      await expect(
        f.owner("UPDATE marketing_consent SET granted = true WHERE player_id = $1", [who]),
      ).rejects.toThrow(/can never be changed/);
      await expect(
        f.owner("DELETE FROM marketing_consent WHERE player_id = $1", [who]),
      ).rejects.toThrow(/can never be changed/);
      await expect(f.owner("TRUNCATE marketing_consent")).rejects.toThrow(/can never be changed/);
      const [state] = await f.owner<{ opted_in: boolean }>(
        "SELECT opted_in FROM marketing_state WHERE player_id = $1 AND channel = 'email'",
        [who],
      );
      expect(state?.opted_in).toBe(false);
    });

    it("keeps log and state agreeing when one player's changes race", async () => {
      const who = await player();
      await Promise.all(
        Array.from({ length: 12 }, (_, i) => set(who, { sms: i % 2 === 0, push: i % 3 === 0 })),
      );
      for (const channel of ["sms", "push"] as const) {
        const [last] = await f.owner<{ granted: boolean }>(
          "SELECT granted FROM marketing_consent WHERE player_id = $1 AND channel = $2 ORDER BY id DESC LIMIT 1",
          [who, channel],
        );
        const [state] = await f.owner<{ opted_in: boolean }>(
          "SELECT opted_in FROM marketing_state WHERE player_id = $1 AND channel = $2",
          [who, channel],
        );
        expect(state?.opted_in, channel).toBe(last?.granted);
      }
    });
  });

  describe("the opt-out link's door", () => {
    it("turns the channel off with its own method, once", async () => {
      const who = await player();
      await set(who, { sms: true, email: true });
      expect(await optOut(who, "sms")).toBe("opted_out");
      expect(await optOut(who, "sms")).toBe("already_off");
      expect((await own(who)).channels).toMatchObject({
        sms: { optedIn: false },
        email: { optedIn: true },
      });
      expect((await log(who)).at(-1)).toEqual({
        channel: "sms",
        granted: false,
        method: "opt_out_link",
        text_version: null,
      });
      expect(await count("marketing_consent WHERE player_id = $1", [who])).toBe(3);
    });

    it("works for a banned player, and answers gone for an unknown or erased one", async () => {
      const banned = await player();
      await set(banned, { push: true });
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
      expect(await optOut(banned, "push")).toBe("opted_out");
      expect(await optOut(randomUUID(), "push")).toBe("gone");
      const erased = await player();
      await f.owner("UPDATE player SET status = 'deleted', username = NULL WHERE id = $1", [
        erased,
      ]);
      expect(await optOut(erased, "push")).toBe("gone");
    });

    it("refuses an unknown channel", async () => {
      expect(await refusal(optOut(await player(), "fax"))).toBe("MK422:channel");
    });

    it("is closed to the API role's direct table access", async () => {
      await expect(f.db.app.query("SELECT * FROM marketing_consent")).rejects.toThrow(
        /permission denied/,
      );
      await expect(f.db.app.query("SELECT * FROM marketing_state")).rejects.toThrow(
        /permission denied/,
      );
      await expect(f.db.app.query("SELECT * FROM player_preference")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe("the promotional audience", () => {
    it("holds only players opted in on that channel, active, in the city and with an interest asked for", async () => {
      const city = "sa-najran";
      const pushOnly = await player();
      const smsOnly = await player();
      const both = await player();
      const none = await player();
      const banned = await player();
      const erased = await player();
      const withdrew = await player();
      const underAge = await player();
      const noBirthYear = await player();
      const smsNoPhone = await player();
      for (const who of [
        pushOnly,
        smsOnly,
        both,
        none,
        banned,
        erased,
        withdrew,
        underAge,
        noBirthYear,
        smsNoPhone,
      ]) {
        await call(who, "SELECT set_preferences($1, $2::text[]) AS r", [city, ["sport"]]);
      }
      await set(pushOnly, { push: true });
      await set(smsOnly, { sms: true });
      await set(both, { push: true, sms: true });
      await set(none, { push: false, sms: false, email: false });
      await set(banned, { push: true });
      await set(erased, { push: true });
      await set(withdrew, { push: true });
      await set(withdrew, { push: false });
      await set(underAge, { push: true, sms: true });
      await set(noBirthYear, { push: true, sms: true });
      // SMS reaches only a player with a phone (T-409's promo_pool): the fixture's players have an email only.
      await set(smsNoPhone, { sms: true });
      await givePhone(smsOnly);
      await givePhone(both);
      await f.owner("UPDATE player SET birth_year = $2 WHERE id = $1", [
        underAge,
        (await year()) - 15,
      ]);
      await f.owner("UPDATE player SET birth_year = NULL WHERE id = $1", [noBirthYear]);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
      await f.owner("UPDATE player SET status = 'deleted', username = NULL WHERE id = $1", [
        erased,
      ]);

      expect((await audience("push", city)).toSorted()).toEqual([pushOnly, both].toSorted());
      expect((await audience("sms", city)).toSorted()).toEqual([smsOnly, both].toSorted());
      expect(await audience("email", city)).toEqual([]);
      expect((await audience("push", city, ["sport"])).toSorted()).toEqual(
        [pushOnly, both].toSorted(),
      );
      expect(await audience("push", city, ["music"])).toEqual([]);
      expect(await audience("push", "sa-hail")).toEqual([]);
      expect(await audience("fax", city)).toEqual([]);
    });

    it("pages by player id and caps a page", async () => {
      const city = "sa-jazan";
      const made: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const who = await player();
        await call(who, "SELECT set_preferences($1, '{}'::text[]) AS r", [city]);
        await set(who, { email: true });
        made.push(who);
      }
      made.sort();
      const page = async (after: string | null, size: number) =>
        (
          await f.owner<{ player_id: string }>(
            "SELECT player_id FROM marketing_audience('email', $1, NULL, $2, $3)",
            [city, after, size],
          )
        ).map((row) => row.player_id);
      expect(await page(null, 2)).toEqual(made.slice(0, 2));
      expect(await page(made[1] ?? null, 2)).toEqual(made.slice(2));
      expect(await page(null, 0)).toEqual(made.slice(0, 1));
      expect((await page(null, 100000)).length).toBe(4);
    });
  });

  describe("an admin's read of a player's consent", () => {
    it("shows each channel and the log newest first, and audits the read", async () => {
      const who = await player();
      await set(who, { sms: true }, "signup");
      await set(who, { sms: false });
      const before = await count("audit_log WHERE action = 'marketing.consent_read'");
      const [row] = await readConsent(who);
      expect(row?.r.channels.sms.optedIn).toBe(false);
      expect(row?.r.history).toMatchObject([
        { channel: "sms", granted: false, method: "settings", textVersion: null },
        { channel: "sms", granted: true, method: "signup", textVersion: "1" },
      ]);
      expect(await count("audit_log WHERE action = 'marketing.consent_read'")).toBe(before + 1);
      const [audit] = await f.owner<{ target_id: string; actor_id: string; after: unknown }>(
        "SELECT target_id, actor_id, after FROM audit_log WHERE action = 'marketing.consent_read' ORDER BY id DESC LIMIT 1",
      );
      expect(audit).toEqual({ target_id: who, actor_id: admin, after: null });
    });

    it("refuses anyone who is not an active platform admin, and an unknown player", async () => {
      const who = await player();
      expect(
        await refusal(
          f.run({ playerId: who }, "SELECT marketing_consent_history($1, $2)", [who, randomUUID()]),
        ),
      ).toBe("QY403");
      expect(
        await refusal(
          f.run(f.team(), "SELECT marketing_consent_history($1, $2)", [who, randomUUID()]),
        ),
      ).toBe("QY403");
      expect(await refusal(readConsent(randomUUID()))).toBe("QY404");
    });
  });

  describe("preferences", () => {
    it("stores a city and interests in catalog order, replaces them and clears them", async () => {
      const who = await player();
      expect(await call(who, "SELECT own_preferences() AS r")).toEqual({
        cityId: null,
        interests: [],
      });
      expect(await save(who, "sa-riyadh", ["travel", "sport", "music"])).toEqual({
        cityId: "sa-riyadh",
        interests: ["sport", "music", "travel"],
      });
      expect(await save(who, null, ["food"])).toEqual({ cityId: null, interests: ["food"] });
      expect(await save(who, null, [])).toEqual({ cityId: null, interests: [] });
      expect(await call(who, "SELECT own_preferences() AS r")).toEqual({
        cityId: null,
        interests: [],
      });
    });

    it("refuses an unknown city, an unknown or repeated interest, nine interests", async () => {
      const who = await player();
      expect(await refusal(save(who, "sa-nowhere", []))).toBe("PF422:cityId");
      expect(await refusal(save(who, null, ["sport", "bogus"]))).toBe("PF422:interests");
      expect(await refusal(save(who, null, ["sport", "sport"]))).toBe("PF422:interests");
      expect(
        await refusal(
          save(who, null, [
            "sport",
            "music",
            "tech",
            "gaming",
            "food",
            "art",
            "culture",
            "learning",
            "business",
          ]),
        ),
      ).toBe("PF422:interests");
      expect(
        await refusal(
          save(who, null, [
            "sport",
            "music",
            "tech",
            "gaming",
            "food",
            "art",
            "culture",
            "learning",
          ]),
        ),
      ).toBe("none");
      expect(await refusal(call(randomUUID(), "SELECT own_preferences() AS r"))).toBe("PI401");
    });

    it("lists the catalog and the cities", async () => {
      const list = await call<{ id: string }[]>(await player(), "SELECT interest_list() AS r");
      expect(list.map((row) => row.id)).toHaveLength(12);
      expect(list[0]).toEqual({ id: "sport", name: { ar: "رياضة", en: "Sport" } });
    });
  });

  describe("event interests", () => {
    it("takes up to three catalog interests, in catalog order, from the event team", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      expect(await readEventInterests(event)).toEqual([]);
      await setEvent(event, ["travel", "sport", "music"]);
      expect(await readEventInterests(event)).toEqual(["sport", "music", "travel"]);
      await setEvent(event, []);
      expect(await readEventInterests(event)).toEqual([]);
    });

    it("refuses four, an unknown one and a repeat, and leaves the event as it was", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      await setEvent(event, ["art"]);
      expect(await refusal(setEvent(event, ["sport", "music", "tech", "food"]))).toBe("EI422");
      expect(await refusal(setEvent(event, ["bogus"]))).toBe("EI422");
      expect(await refusal(setEvent(event, ["art", "art"]))).toBe("EI422");
      expect(await readEventInterests(event)).toEqual(["art"]);
    });

    it("is not writable by another organizer's team", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      const other = await f.run(
        { organizerId: f.ids.orgB, staffUserId: f.ownerA },
        "UPDATE event SET interests = ARRAY['art'] WHERE id = $1 RETURNING id",
        [event],
      );
      expect(other).toEqual([]);
      expect(await readEventInterests(event)).toEqual([]);
    });
  });

  describe("For you", () => {
    it("lists public upcoming and live events that match by interest or city, both first", async () => {
      const who = await player();
      await call(who, "SELECT set_preferences('sa-tabuk', ARRAY['sport','music']) AS r");
      const both = await tagged({ phase: "scheduled", cityId: "sa-tabuk" }, ["sport"]);
      const twoInterests = await tagged({ phase: "live" }, ["sport", "music"]);
      const oneInterest = await tagged({ phase: "scheduled" }, ["music", "art"]);
      const cityOnly = await tagged({ phase: "scheduled", cityId: "sa-tabuk" }, ["food"]);
      const nothing = await tagged({ phase: "scheduled", cityId: "sa-hail" }, ["food"]);
      const list = await forYou(who);
      const ids = list.map((row) => row.id);
      expect(ids.slice(0, 4)).toEqual([both, twoInterests, oneInterest, cityOnly]);
      expect(ids).not.toContain(nothing);
      expect(list[0]).toMatchObject({ city: { en: "Tabuk" }, interests: ["sport"] });
      expect(list[1]?.statusNow).toBe("live");
    });

    it("leaves out private, unlisted, unlisted-by-method, ended and joined events", async () => {
      const who = await player();
      await call(who, "SELECT set_preferences(NULL, ARRAY['gaming']) AS r");
      const shown = await tagged({ phase: "scheduled" }, ["gaming"]);
      const hidden = [
        await tagged({ phase: "scheduled", access: "unlisted" }, ["gaming"], "{code}"),
        await tagged({ phase: "scheduled", access: "private" }, ["gaming"], "{code}"),
        await tagged({ phase: "scheduled" }, ["gaming"], "{code,qr}"),
        await tagged({ phase: "ended" }, ["gaming"]),
      ];
      const joined = await tagged({ phase: "scheduled" }, ["gaming"]);
      await f.join(joined, who);
      const ids = (await forYou(who)).map((row) => row.id);
      expect(ids).toContain(shown);
      for (const event of [...hidden, joined]) expect(ids).not.toContain(event);
    });

    it("is empty for a player with no interests and no city, and caps the list at 20", async () => {
      const blank = await player();
      await tagged({ phase: "scheduled" }, ["wellness"]);
      expect(await forYou(blank)).toEqual([]);
      const keen = await player();
      await call(keen, "SELECT set_preferences(NULL, ARRAY['family']) AS r");
      for (let i = 0; i < 22; i += 1) await tagged({ phase: "scheduled" }, ["family"]);
      expect((await forYou(keen)).length).toBe(20);
    });

    it("answers 401-shaped for a caller who is not an active player", async () => {
      expect(await refusal(forYou(randomUUID()))).toBe("PI401");
    });
  });

  describe("erasure", () => {
    it("removes the preferences, the state and the whole consent log with the account", async () => {
      const who = await player();
      await set(who, { sms: true, push: true });
      await call(who, "SELECT set_preferences('sa-abha', ARRAY['art']) AS r");
      const token = await f.deletionToken(who);
      const [erased] = await f.run<{ outcome: string }>(
        { playerId: who },
        "SELECT outcome FROM erase_player($1, true, $2)",
        [token, randomUUID()],
      );
      expect(erased?.outcome).toBe("erased");
      expect(await count("marketing_consent WHERE player_id = $1", [who])).toBe(0);
      expect(await count("marketing_state WHERE player_id = $1", [who])).toBe(0);
      expect(await count("player_preference WHERE player_id = $1", [who])).toBe(0);
    });
  });

  describe("restated by T-409 (migration 0073)", () => {
    it("records the consent's language on the log and copies it to the state", async () => {
      const who = await player();
      await call(who, "SELECT set_marketing($1::jsonb, 'settings', '1', 'en') AS r", [
        JSON.stringify({ sms: true }),
      ]);
      expect(await languageOf(who)).toEqual({ log: "en", state: "en" });
      await call(who, "SELECT set_marketing($1::jsonb, 'settings', '1', 'ar') AS r", [
        JSON.stringify({ sms: false }),
      ]);
      expect(await languageOf(who)).toEqual({ log: "ar", state: "ar" });
    });

    it("still takes the 3-argument call of the API running during the deploy, with no language", async () => {
      const who = await player();
      expect((await set(who, { sms: true })).channels.sms.optedIn).toBe(true);
      expect(await languageOf(who)).toEqual({ log: null, state: null });
    });

    it("refuses a language other than ar or en, and writes nothing", async () => {
      const who = await player();
      const answer = call(who, "SELECT set_marketing($1::jsonb, 'settings', '1', 'fr') AS r", [
        JSON.stringify({ sms: true }),
      ]);
      await expect(answer).rejects.toMatchObject({ code: "MK422", detail: "language" });
      expect(await log(who)).toEqual([]);
    });

    it("reads the promotional audience in the system context only", async () => {
      const sql = "SELECT player_id FROM marketing_audience('sms', NULL, NULL, NULL, 10)";
      const who = await player();
      for (const context of [
        { playerId: who },
        f.team(),
        { isAdmin: true, staffUserId: admin },
        { deviceId: randomUUID() },
      ]) {
        await expect(f.run(context, sql)).rejects.toMatchObject({ code: "MK403" });
      }
      expect(Array.isArray(await f.run({}, sql))).toBe(true);
    });
  });
});
