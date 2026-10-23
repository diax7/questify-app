import { createHash, randomBytes, randomUUID } from "node:crypto";
import { playerDocuments } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RankingStore } from "#src/ranking/store";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Upsert = Readonly<{ event: string; enrollmentId: string; score: bigint }>;

/** A ranking copy that only records what is written to it, so a test can see which completions moved a place. */
const recordingStore = (upserts: Upsert[]): RankingStore => ({
  upsert: async (event, entry) => {
    upserts.push({ event, enrollmentId: entry.enrollmentId, score: entry.score });
  },
  remove: async () => undefined,
  read: async () => ({ top: [], total: 1, place: 1 }),
  rebuild: async () => "rebuilt",
  builtAt: async () => undefined,
});

const GUIDELINES =
  playerDocuments().find((document) => document.id === "community_guidelines")?.version ?? "";

/**
 * Submission quests over HTTP (T-301): sending with the guidelines gate and the pending points on Home, the player's
 * own list, the dashboard's queue, review, removal and seen marks, the operator's queue and review, the quest builder's
 * refusal of photo and video, and each refusal's answer.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("submission quests over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;
  const upserts: Upsert[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, false, {}, { rankingStore: recordingStore(upserts) });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('sub-org', 'sub-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@sub.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@sub.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Sub Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `SUBH${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, autoApprove = false) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'submission', 'Tell us', 150, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, JSON.stringify({ accepts: ["text"], autoApprove, resubmit: false })],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string, accepted = true) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`sub_http_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (accepted) {
      await owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'community_guidelines', $2, 'submission')`,
        [id, GUIDELINES],
      );
    }
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      organizer,
      event,
      id,
    ]);
    return { id, token };
  };
  const app = (
    method: "GET" | "POST",
    path: string,
    token: string,
    payload?: object,
    key: string = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (method: "GET" | "POST", path: string, payload?: object, key = randomUUID()) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });
  const send = (token: string, quest: string, text: string, key: string = randomUUID()) =>
    app("POST", `/v1/quests/${quest}/submit`, token, { text }, key);

  it("sends text, shows it pending on Home and in the player's list, and pays on approval", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const key = randomUUID();
    const sent = await send(sara.token, quest, "  Our team built a robot  ", key);
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      status: "pending",
      points: 150,
      completionId: null,
      levelUp: null,
      rank: null,
      replayed: false,
    });
    // A retry gets the first answer back, from the idempotency store.
    expect((await send(sara.token, quest, "  Our team built a robot  ", key)).json()).toEqual(
      sent.json(),
    );
    const home = await app("GET", `/v1/events/${event}/home`, sara.token);
    expect(home.json()).toMatchObject({ standing: { balance: 0, pendingPoints: 150 } });
    const mine = await app("GET", `/v1/events/${event}/submissions/mine`, sara.token);
    expect(mine.json()).toMatchObject({
      pendingPoints: 150,
      submissions: [{ questId: quest, status: "pending", text: "Our team built a robot" }],
    });

    const queue = await dashboard("GET", `/events/${event}/submissions?filter=pending`);
    const item = queue.json<{ submissions: Row[]; nextCursor: string | null }>();
    expect(item.submissions).toHaveLength(1);
    expect(item.nextCursor).toBeNull();
    const id = String(item.submissions[0]?.["id"]);
    const approved = await dashboard("POST", `/events/${event}/submissions/${id}/review`, {
      decision: "approve",
    });
    expect(approved.json()).toEqual({
      submissionId: id,
      status: "approved",
      points: 150,
      replayed: false,
    });
    // The reviewer's approval moves the player's place, as a completion does.
    expect(upserts.filter((write) => write.event === event)).toEqual([
      { event, enrollmentId: expect.any(String), score: 150n },
    ]);
    const again = await dashboard("POST", `/events/${event}/submissions/${id}/review`, {
      decision: "approve",
    });
    expect([again.statusCode, again.json().code]).toEqual([409, "already_reviewed"]);
    const after = await app("GET", `/v1/events/${event}/home`, sara.token);
    expect(after.json()).toMatchObject({
      standing: { score: 150, balance: 150, pendingPoints: 0 },
    });

    const removed = await dashboard("POST", `/events/${event}/submissions/${id}/remove`, {
      reason: "Copied from the web",
    });
    expect(removed.json()).toMatchObject({ scoreDelta: -150, balanceDelta: -150 });
  });

  it("answers each refusal of a send", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const fresh = await newPlayer(event, false);
    const guidelines = await send(fresh.token, quest, "Hello");
    expect([guidelines.statusCode, guidelines.json().code]).toEqual([403, "guidelines_required"]);
    const sara = await newPlayer(event);
    const empty = await send(sara.token, quest, "   ");
    expect([empty.statusCode, empty.json().code, empty.json().details]).toEqual([
      422,
      "submission_text",
      { reason: "empty" },
    ]);
    await send(sara.token, quest, "First");
    const twice = await send(sara.token, quest, "Second");
    expect([twice.statusCode, twice.json().code]).toEqual([409, "submission_pending"]);
    const reserved = await send(sara.token, quest, "Hello", "sub:1");
    expect([reserved.statusCode, reserved.json().code]).toEqual([400, "idempotency_key_invalid"]);
    const missing = await send(sara.token, randomUUID(), "Hello");
    expect(missing.statusCode).toBe(404);
  });

  it("closes the quest after a rejection without resubmit, and says why", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const sent = await send(sara.token, quest, "Hello");
    const id = String(sent.json().submissionId);
    const noReason = await dashboard("POST", `/events/${event}/submissions/${id}/review`, {
      decision: "reject",
      reason: " ",
    });
    expect([noReason.statusCode, noReason.json().code]).toEqual([400, "reason_required"]);
    await dashboard("POST", `/events/${event}/submissions/${id}/review`, {
      decision: "reject",
      reason: "Off topic",
    });
    const closed = await send(sara.token, quest, "Again");
    expect([closed.statusCode, closed.json().code]).toEqual([409, "submission_closed"]);
    const remove = await dashboard("POST", `/events/${event}/submissions/${id}/remove`, {
      reason: "x",
    });
    expect([remove.statusCode, remove.json().code]).toEqual([409, "already_reviewed"]);
  });

  it("pays an auto-approve quest at once and lets the team mark it seen", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, true);
    const sara = await newPlayer(event);
    const sent = await send(sara.token, quest, "Done!");
    expect(sent.json()).toMatchObject({ status: "approved", score: 150, balance: 150, rank: 1 });
    const unseen = await dashboard("GET", `/events/${event}/submissions?filter=unseen`);
    const ids = unseen.json<{ submissions: Row[] }>().submissions.map((row) => String(row["id"]));
    expect(ids).toEqual([String(sent.json().submissionId)]);
    expect((await dashboard("POST", `/events/${event}/submissions/seen`, { ids })).json()).toEqual({
      marked: 1,
    });
  });

  it("lets an operator with review work the queue, and refuses one without it", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sara = await newPlayer(event);
    const sent = await send(sara.token, quest, "Hello");
    const reviewer = await newPlayer(event);
    const plain = await newPlayer(event);
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4), ($1, $2, $5, $6)",
      [organizer, event, reviewer.id, ["review"], plain.id, ["award"]],
    );
    const queue = await app("GET", `/v1/operator/events/${event}/submissions`, reviewer.token);
    expect(queue.json<{ submissions: Row[] }>().submissions.map((row) => row["id"])).toEqual([
      String(sent.json().submissionId),
    ]);
    const off = await app("GET", `/v1/operator/events/${event}/submissions`, plain.token);
    expect([off.statusCode, off.json().code]).toEqual([403, "ability_off"]);
    const review = await app(
      "POST",
      `/v1/operator/events/${event}/submissions/${sent.json().submissionId}/review`,
      reviewer.token,
      { decision: "reject", reason: "Please write more" },
    );
    expect(review.json()).toMatchObject({ status: "rejected" });
    const mine = await app("GET", `/v1/events/${event}/submissions/mine`, sara.token);
    expect(mine.json()).toMatchObject({
      pendingPoints: 0,
      submissions: [{ status: "rejected", reason: "Please write more", resubmit: false }],
    });
    expect(upserts.filter((write) => write.event === event)).toEqual([]);

    const second = await send(sara.token, await newQuest(event), "Again");
    const approved = await app(
      "POST",
      `/v1/operator/events/${event}/submissions/${second.json().submissionId}/review`,
      reviewer.token,
      { decision: "approve" },
    );
    expect(approved.json()).toEqual({
      submissionId: String(second.json().submissionId),
      status: "approved",
      points: 150,
      replayed: false,
    });
    expect(upserts.filter((write) => write.event === event)).toEqual([
      { event, enrollmentId: expect.any(String), score: 150n },
    ]);
  });

  it("pages both queues by cursor, and refuses a filter it does not know", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const sent: string[] = [];
    for (const text of ["One", "Two"]) {
      const sara = await newPlayer(event);
      sent.push(String((await send(sara.token, quest, text)).json().submissionId));
    }
    const reviewer = await newPlayer(event);
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [organizer, event, reviewer.id, ["review"]],
    );
    type Page = { submissions: Row[]; nextCursor: string | null };
    const walk = async (read: (cursor: string) => Promise<Page>) => {
      const first = await read("");
      const second = await read(`&cursor=${first.nextCursor}`);
      const third = await read(`&cursor=${second.nextCursor}`);
      expect(first.nextCursor).toBe(first.submissions[0]?.["id"]);
      expect([third.submissions, third.nextCursor]).toEqual([[], null]);
      return [...first.submissions, ...second.submissions].map((row) => String(row["id"]));
    };
    const team = await walk(async (cursor) =>
      (
        await dashboard("GET", `/events/${event}/submissions?filter=pending&limit=1${cursor}`)
      ).json<Page>(),
    );
    expect(team.toSorted()).toEqual(sent.toSorted());
    const operator = await walk(async (cursor) =>
      (
        await app(
          "GET",
          `/v1/operator/events/${event}/submissions?limit=1${cursor}`,
          reviewer.token,
        )
      ).json<Page>(),
    );
    expect(operator).toEqual(team);
    const listed = await dashboard("GET", `/events/${event}/submissions?filter=done`);
    expect(listed.json()).toEqual({ submissions: [], nextCursor: null });
    const unknown = await dashboard("GET", `/events/${event}/submissions?filter=everything`);
    expect([unknown.statusCode, unknown.json().code]).toEqual([400, "invalid_request"]);
  });

  it("refuses a submission quest that asks for photos or video, with its own message", async () => {
    const event = await newEvent();
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [event],
    );
    const create = (accepts: string[]) =>
      dashboard("POST", `/events/${event}/quests`, {
        categoryId: category?.id,
        type: "submission",
        title: { en: "Show us" },
        points: 50,
        config: { accepts },
      });
    for (const [accepts, asked] of [
      [["video"], "video"],
      [["photo"], "photo"],
    ] as const) {
      const refused = await create([...accepts]);
      expect([refused.statusCode, refused.json().code, refused.json().details]).toEqual([
        422,
        "submission_kind_unavailable",
        { asked },
      ]);
    }
    const made = await create(["text"]);
    expect(made.statusCode).toBe(201);
    expect(made.json().quest).toMatchObject({
      type: "submission",
      config: { accepts: ["text"], autoApprove: false, resubmit: false },
      verification: [],
    });
  });
});
