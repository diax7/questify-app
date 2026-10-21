import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import type { RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRankingStore } from "#src/ranking/store";
import {
  DASHBOARD_ORIGIN,
  PASSWORD,
  browserHeaders,
  freshIp,
  sessionCookieOf,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";
import { TEST_REDIS_URL, createTestRedis } from "#test/support/test-redis";

const ORGANIZER_ACCEPT = { terms: "0.1", dpa: "0.1", contentRules: "0.1" };
const PLAYER_ACCEPT = { terms: "0.1", privacy: "0.1" };

type Phone = Readonly<{ username: string; token: string }>;
type RankingView = Readonly<{
  rows: readonly { rank: number; username: string; score: number; isMe: boolean }[];
  me: Readonly<{ rank: number; score: number }> | null;
}>;

const expectStatus = (response: LightMyRequestResponse, status: number): LightMyRequestResponse => {
  expect(response.statusCode, `${response.statusCode} ${response.body}`).toBe(status);
  return response;
};

/**
 * The first loop (T-118), the way the dashboard and two phones drive it: an organizer signs up and builds an event
 * with one QR quest, two players sign up by SMS and join by the event's code, one scans, and both phones see the new
 * ranking and the scanner's balance. Every step is a real route; the one database write stands in for Questify's
 * activation of the event (T-210, not built yet). Runs on the Redis ranking copy when TEST_REDIS_URL is set
 * (production, ADR-118), otherwise on PostgreSQL.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the first loop (T-118)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let redis: RedisClientType | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    if (TEST_REDIS_URL === undefined) {
      test = await startApp(db);
    } else {
      redis = await createTestRedis();
      test = await startApp(db, false, {}, { rankingStore: createRankingStore(redis) });
    }
  });
  afterAll(async () => {
    await test.close();
    await redis?.close();
    await db.close();
  });

  /** The organizer signs up on the dashboard and gets a session in their new organizer. */
  const organizerSignsUp = async (): Promise<{ cookie: string; organizerId: string }> => {
    const email = "owner@loop.test";
    const started = await test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-up",
      headers: browserHeaders(),
      payload: { email, password: PASSWORD, organizerName: "Loop Expo", accept: ORGANIZER_ACCEPT },
    });
    const { challengeToken } = expectStatus(started, 200).json<{ challengeToken: string }>();
    const done = await test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-up/code",
      headers: browserHeaders(),
      payload: { challengeToken, code: test.mail.lastCode(email) },
    });
    const { organizerId } = expectStatus(done, 200).json<{ organizerId: string }>();
    return { cookie: sessionCookieOf(done), organizerId };
  };

  const staff = (
    cookie: string,
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });

  /** The organizer builds the event and its quest, and prints the quest's QR code. */
  const buildEvent = async (cookie: string, organizerId: string) => {
    const made = await staff(cookie, "POST", `/v1/organizers/${organizerId}/events`, {
      name: { ar: "ملتقى الحلقة", en: "Loop Meetup" },
      timezone: "Asia/Riyadh",
      startsAt: "2030-11-01T09:00",
      endsAt: "2030-11-01T17:00",
    });
    const { event } = expectStatus(made, 201).json<{ event: { id: string; joinCode: string } }>();
    const base = `/v1/organizers/${organizerId}/events/${event.id}`;
    const builder = expectStatus(await staff(cookie, "GET", `${base}/quests`), 200);
    const general = builder.json<{ categories: { id: string }[] }>().categories[0]?.id;
    const quest = await staff(cookie, "POST", `${base}/quests`, {
      categoryId: general,
      type: "scan_qr",
      title: { ar: "المسرح", en: "Find the stage" },
      points: 25,
    });
    const questId = expectStatus(quest, 201).json<{ quest: { id: string } }>().quest.id;
    const codes = expectStatus(await staff(cookie, "GET", `${base}/codes`), 200);
    const printed = codes.json<{ codes: { questId: string; url: string }[] }>().codes;
    const url = printed.find((code) => code.questId === questId)?.url;
    expect(url).toMatch(new RegExp(`^${DASHBOARD_ORIGIN}/q/`));
    return { eventId: event.id, joinCode: event.joinCode, questId, qrUrl: url ?? "" };
  };

  /** Questify activates the event and its start time passes (T-210 will do this from the console). */
  const goLive = async (eventId: string): Promise<void> => {
    await db.owner.query(
      "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
      [eventId],
    );
  };

  const player = (
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: { "x-forwarded-for": freshIp(), ...headers },
      ...(payload === undefined ? {} : { payload }),
    });

  /** A phone signs up by SMS code, reads the join card and joins by the event's code. */
  const phoneJoins = async (phone: string, username: string, joinCode: string): Promise<Phone> => {
    const asked = await player(
      "POST",
      "/v1/auth/code",
      {},
      {
        channel: "phone",
        value: phone,
        accept: PLAYER_ACCEPT,
      },
    );
    const { challengeToken } = expectStatus(asked, 202).json<{ challengeToken: string }>();
    const verified = await player(
      "POST",
      "/v1/auth/verify",
      {},
      {
        challengeToken,
        code: test.sms.lastCode(phone),
      },
    );
    const { signupToken } = expectStatus(verified, 200).json<{ signupToken: string }>();
    const created = await player(
      "POST",
      "/v1/auth/signup",
      {},
      {
        signupToken,
        username,
        birthYear: 1998,
        avatar: "falcon",
      },
    );
    const { accessToken } = expectStatus(created, 201).json<{ accessToken: string }>();
    const card = expectStatus(await player("GET", `/v1/public/events/${joinCode}`, {}), 200);
    const cardVersion = card.json<{ card: { version: string } }>().card.version;
    const auth = { authorization: `Bearer ${accessToken}` };
    const joined = await player("POST", "/v1/join", auth, { joinCode, via: "code", cardVersion });
    expect(expectStatus(joined, 200).json()).toMatchObject({
      status: "active",
      alreadyMember: false,
    });
    return { username, token: accessToken };
  };

  const ranking = async (phone: Phone, eventId: string): Promise<RankingView> =>
    expectStatus(
      await player("GET", `/v1/events/${eventId}/ranking`, {
        authorization: `Bearer ${phone.token}`,
      }),
      200,
    ).json<RankingView>();

  const balance = async (phone: Phone, eventId: string): Promise<number | undefined> =>
    expectStatus(
      await player("GET", `/v1/events/${eventId}/home`, { authorization: `Bearer ${phone.token}` }),
      200,
    ).json<{ standing: { balance?: number } }>().standing.balance;

  it("creates an event, joins two phones, scans a quest, and both phones see the new ranking", async () => {
    const { cookie, organizerId } = await organizerSignsUp();
    const event = await buildEvent(cookie, organizerId);
    await goLive(event.eventId);

    const first = await phoneJoins("+966510000001", "loop_scanner", event.joinCode);
    const second = await phoneJoins("+966510000002", "loop_watcher", event.joinCode);
    expect(await balance(first, event.eventId)).toBe(0);

    const scanned = await player(
      "POST",
      `/v1/quests/${event.questId}/complete`,
      { authorization: `Bearer ${first.token}`, "idempotency-key": randomUUID() },
      { proof: { type: "qr", code: event.qrUrl.slice(`${DASHBOARD_ORIGIN}/q/`.length) } },
    );
    expect(expectStatus(scanned, 200).json()).toMatchObject({
      points: 25,
      score: 25,
      balance: 25,
      // The place comes from the Redis copy only; null proves nothing fell back silently.
      rank: redis === undefined ? null : 1,
    });

    expect(await balance(first, event.eventId)).toBe(25);
    expect(await balance(second, event.eventId)).toBe(0);
    const seen = await ranking(second, event.eventId);
    expect(seen.rows).toEqual([
      expect.objectContaining({ rank: 1, username: "loop_scanner", score: 25, isMe: false }),
    ]);
    expect(seen.me).toBeNull();
    expect((await ranking(first, event.eventId)).me).toMatchObject({ rank: 1, score: 25 });
  });
});
