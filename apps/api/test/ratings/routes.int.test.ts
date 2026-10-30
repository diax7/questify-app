import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

const text = (en: string) => ({ ar: null, en });
const SURVEY = {
  questions: [
    { id: "stars", text: text("How was it?"), kind: "rating", required: true },
    { id: "note", text: text("Anything else?"), kind: "text", required: false },
  ],
};

type Player = { id: string; enrollment: string; token: string };

/**
 * Quest ratings and the speaker's survey link over HTTP (T-508, ADR-376): the owner's switch, the player's rating, the
 * team's counts and the link a speaker opens with no account, each from every seat that must be refused.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "quest ratings and survey results over HTTP",
  () => {
    let fixture: PushFixture;
    let test: TestApp;
    let owner: string;
    let editor: string;
    let other: string;
    let viewer: string;
    let event: string;

    const bearer = async (id: string): Promise<string> => {
      const value = randomBytes(32).toString("base64url");
      await fixture.owner(
        "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, createHash("sha256").update(value).digest()],
      );
      return value;
    };
    beforeAll(async () => {
      fixture = await pushFixture();
      test = await startApp(fixture.db);
      const staff = async (name: string, role: string, organizer = fixture.ids.orgA) => {
        const email = name + "@rating.test";
        const id = await createStaff(fixture.db.owner, { email });
        await fixture.owner(
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, NULL)",
          [organizer, id, role],
        );
        return signInFully(test, email);
      };
      await fixture.owner("UPDATE organizer_member SET role = 'editor' WHERE organizer_id = $1", [
        fixture.ids.orgA,
      ]);
      owner = await staff("owner", "owner");
      editor = await staff("editor", "editor");
      other = await staff("other", "owner", fixture.ids.orgB);
      await createStaff(fixture.db.owner, { email: "viewer@rating.test" });
      viewer = await signInFully(test, "viewer@rating.test");
      event = await fixture.newEvent({ phase: "live" });
    });
    afterAll(async () => {
      await test.close();
      await fixture.close();
    });

    const base = (id = event) => "/v1/organizers/" + fixture.ids.orgA + "/events/" + id;
    const team = (
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      payload?: object,
      session = owner,
    ) =>
      test.app.inject({
        method,
        url,
        headers: withSession(session, { "idempotency-key": randomUUID() }),
        ...(payload === undefined ? {} : { payload }),
      });
    const asPlayer = (
      method: "GET" | "PUT",
      url: string,
      player: Player | null,
      payload?: object,
    ) =>
      test.app.inject({
        method,
        url,
        ...(player === null ? {} : { headers: { authorization: "Bearer " + player.token } }),
        ...(payload === undefined ? {} : { payload }),
      });
    const member = async (ev = event): Promise<Player> => {
      const id = await fixture.newPlayer();
      return { id, enrollment: await fixture.join(ev, id), token: await bearer(id) };
    };
    const quest = async (type = "scan_qr", config = "{}", ev = event): Promise<string> =>
      (
        await fixture.owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, $2, 'Station', 40, 1, true, $3::jsonb FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
          [ev, type, config],
        )
      )[0]?.id ?? "";
    const complete = async (player: Player, questId: string, ev = event, method = "qr") => {
      const [org] = await fixture.owner<{ organizer_id: string }>(
        "SELECT organizer_id FROM event WHERE id = $1",
        [ev],
      );
      const [row] = await fixture.owner<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       VALUES ($1, $2, $3, $4, 1, $5, $6) RETURNING id`,
        [org?.organizer_id, ev, player.enrollment, questId, method, randomUUID()],
      );
      return row?.id ?? "";
    };
    const open = (token: string) =>
      test.app.inject({ method: "POST", url: "/v1/public/survey-results", payload: { token } });

    const survey = async (ev = event) => {
      const questId = await quest("survey", JSON.stringify(SURVEY), ev);
      for (const [stars, note] of [
        [5, "Great talk"],
        [3, "Call me on 0501234567"],
        [4, "write to me at sara@example.com"],
      ] as const) {
        const player = await member(ev);
        const completion = await complete(player, questId, ev, "survey");
        await fixture.owner(
          `INSERT INTO survey_response (organizer_id, event_id, enrollment_id, quest_id, answers, completion_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            fixture.ids.orgA,
            ev,
            player.enrollment,
            questId,
            JSON.stringify({ stars, note }),
            completion,
          ],
        );
      }
      return questId;
    };
    const share = (questId: string, session = owner) =>
      team("POST", base() + "/quests/" + questId + "/survey-share", {}, session);

    describe("ratings", () => {
      it("starts off, lets only the owner turn it on, and shows the switch on the event", async () => {
        const ev = await fixture.newEvent({ phase: "live" });
        expect((await team("GET", base(ev))).json()).toMatchObject({
          event: { questRatings: false },
        });
        expect(
          codeOf(await team("PUT", base(ev) + "/quest-ratings", { enabled: true }, editor)),
        ).toEqual([403, "owner_only"]);
        expect(
          codeOf(await team("PUT", base(ev) + "/quest-ratings", { enabled: true }, other)),
        ).toEqual([404, "not_found"]);
        const on = await team("PUT", base(ev) + "/quest-ratings", { enabled: true });
        expect(on.json()).toEqual({ questRatings: true });
        expect((await team("GET", base(ev))).json()).toMatchObject({
          event: { questRatings: true },
        });
        expect((await team("PUT", base(ev) + "/quest-ratings", { enabled: false })).json()).toEqual(
          {
            questRatings: false,
          },
        );
      });

      it("asks only after the owner turns ratings on, takes a thumb after the quest, and refuses the rest", async () => {
        const ev = await fixture.newEvent({ phase: "live" });
        const station = await quest("scan_qr", "{}", ev);
        const sara = await member(ev);
        const url = "/v1/quests/" + station + "/rating";
        const off = await asPlayer("GET", url, sara);
        expect(off.headers["cache-control"]).toContain("no-store");
        expect(off.json()).toEqual({ on: false, thumb: null });
        expect(codeOf(await asPlayer("PUT", url, sara, { thumb: "up" }))).toEqual([
          409,
          "ratings_off",
        ]);
        await team("PUT", base(ev) + "/quest-ratings", { enabled: true });
        expect((await asPlayer("GET", url, sara)).json()).toEqual({ on: true, thumb: null });
        expect(codeOf(await asPlayer("PUT", url, sara, { thumb: "up" }))).toEqual([
          409,
          "not_completed",
        ]);
        await complete(sara, station, ev);
        for (const bad of [{ thumb: "sideways" }, {}, { thumb: "up", extra: 1 }]) {
          expect(codeOf(await asPlayer("PUT", url, sara, bad)), JSON.stringify(bad)).toEqual([
            422,
            "invalid_rating",
          ]);
        }
        expect((await asPlayer("PUT", url, sara, { thumb: "up" })).json()).toEqual({
          on: true,
          thumb: "up",
        });
        expect((await asPlayer("PUT", url, sara, { thumb: "skip" })).json()).toEqual({
          on: true,
          thumb: "up",
        });
        expect((await asPlayer("GET", url, sara)).json()).toEqual({ on: true, thumb: "up" });
        expect(codeOf(await asPlayer("GET", url, null))[0]).toBe(401);
        const stranger = await member(await fixture.newEvent({ phase: "live" }));
        expect(codeOf(await asPlayer("GET", url, stranger))).toEqual([404, "not_found"]);
        expect(codeOf(await asPlayer("PUT", url, stranger, { thumb: "up" }))).toEqual([
          404,
          "not_found",
        ]);
        expect(
          codeOf(await asPlayer("GET", "/v1/quests/" + randomUUID() + "/rating", sara)),
        ).toEqual([404, "not_found"]);
      });

      it("gives the team each rated quest's counts and no player, to the owner and an editor only", async () => {
        const ev = await fixture.newEvent({ phase: "live" });
        await team("PUT", base(ev) + "/quest-ratings", { enabled: true });
        const station = await quest("scan_qr", "{}", ev);
        for (const thumb of ["up", "up", "down"]) {
          const player = await member(ev);
          await complete(player, station, ev);
          await asPlayer("PUT", "/v1/quests/" + station + "/rating", player, { thumb });
        }
        for (const session of [owner, editor]) {
          const seen = await team("GET", base(ev) + "/quest-ratings", undefined, session);
          expect(seen.headers["cache-control"]).toContain("no-store");
          expect(seen.json()).toEqual({ on: true, scores: [{ questId: station, up: 2, down: 1 }] });
        }
        for (const session of [other, viewer]) {
          expect(
            codeOf(await team("GET", base(ev) + "/quest-ratings", undefined, session))[0],
          ).toBeGreaterThanOrEqual(401);
        }
      });
    });

    describe("the speaker's link", () => {
      it("makes a link for the owner or an editor, shows its state, and opens the results with no account", async () => {
        const questId = await survey();
        const url = base() + "/quests/" + questId + "/survey-share";
        expect((await team("GET", url)).json()).toMatchObject({ shared: false });
        const made = await share(questId, editor);
        expect(made.statusCode).toBe(201);
        expect(made.headers["cache-control"]).toContain("no-store");
        const { token } = made.json<{ token: string }>();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect((await team("GET", url)).json()).toMatchObject({ shared: true });
        const opened = await open(token);
        expect(opened.statusCode).toBe(200);
        expect(opened.headers["cache-control"]).toBe("no-store");
        const body = opened.json<{
          total: number;
          quest: { en: string };
          questions: {
            id: string;
            average: number | null;
            texts: string[] | null;
            hiddenTexts: number;
          }[];
        }>();
        expect(body.total).toBe(3);
        expect(body.quest.en).toBe("Station");
        expect(body.questions[0]?.average).toBe(4);
        expect(body.questions[1]?.texts).toEqual(["Great talk"]);
        expect(body.questions[1]?.hiddenTexts).toBe(2);
        expect(JSON.stringify(body)).not.toMatch(/0501234567|example\.com|enrollment|player/iu);
        const mine = await team("GET", base() + "/quests/" + questId + "/survey");
        expect(
          mine.json<{ questions: { texts: string[] | null }[] }>().questions[1]?.texts,
        ).toHaveLength(3);
      });

      it("stops the old link when a new one is made, and stops them all when sharing stops", async () => {
        const questId = await survey();
        const first = (await share(questId)).json<{ token: string }>().token;
        const second = (await share(questId)).json<{ token: string }>().token;
        expect(codeOf(await open(first))).toEqual([404, "not_found"]);
        expect((await open(second)).statusCode).toBe(200);
        const stopped = await team("DELETE", base() + "/quests/" + questId + "/survey-share");
        expect(stopped.json()).toEqual({ shared: false, removed: true });
        expect(codeOf(await open(second))).toEqual([404, "not_found"]);
        expect(
          (await team("DELETE", base() + "/quests/" + questId + "/survey-share")).json(),
        ).toEqual({ shared: false, removed: false });
      });

      it("refuses a stranger, a quest that is not a survey, and a token that is not the shape of ours", async () => {
        const questId = await survey();
        const plain = await quest();
        for (const session of [other, viewer]) {
          expect((await share(questId, session)).statusCode, "stranger").toBeGreaterThanOrEqual(
            401,
          );
        }
        expect(codeOf(await share(plain))).toEqual([404, "not_found"]);
        expect(codeOf(await share(randomUUID()))).toEqual([404, "not_found"]);
        for (const bad of ["", "short", "a".repeat(44), "a".repeat(42) + "!"]) {
          expect((await open(bad)).statusCode, bad).toBe(400);
        }
        expect(codeOf(await open(randomBytes(32).toString("base64url")))).toEqual([
          404,
          "not_found",
        ]);
        const noBody = await test.app.inject({
          method: "POST",
          url: "/v1/public/survey-results",
          payload: {},
        });
        expect(noBody.statusCode).toBe(400);
      });

      it("counts every try against the address, guessed or not", async () => {
        let last = 0;
        for (let tries = 0; tries < 125 && last !== 429; tries += 1) {
          last = (await open(randomBytes(32).toString("base64url"))).statusCode;
        }
        expect(last).toBe(429);
      });
    });
  },
);
