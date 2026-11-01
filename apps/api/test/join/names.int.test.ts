import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Setup = {
  version: number;
  fields: { id: string; kind: string }[];
  names: { display: string; audience: string; locked: boolean };
};

/**
 * Name display over HTTP (T-615, FR-1842, ADR-400): the dashboard sets how players are named, the card says who will see
 * a full name, the join sends back what it showed and the enrollment keeps it. Everything the screens read on top is
 * tested where those answers are (ranking, results, the big screen, the station and the desk).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("name display over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
  let otherOrganizer: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const made = async (name: string) =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ($1, $1) RETURNING id",
          [name],
        )
      ).rows[0]?.id ?? "";
    organizer = await made("names-org");
    otherOrganizer = await made("names-other");
    const ownerId = await createStaff(db.owner, { email: "owner@names.test" });
    const editorId = await createStaff(db.owner, { email: "editor@names.test" });
    const otherId = await createStaff(db.owner, { email: "owner@names-other.test" });
    await db.owner.query(
      `INSERT INTO organizer_member (organizer_id, staff_user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'editor'), ($4, $5, 'owner')`,
      [organizer, ownerId, editorId, otherOrganizer, otherId],
    );
    ownerCookie = await signInFully(test, "owner@names.test");
    editorCookie = await signInFully(test, "editor@names.test");
    otherCookie = await signInFully(test, "owner@names-other.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (access = "public"): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `NM${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, $2, 'Names Fest', 'live', $3, now() - interval '1 hour', now() + interval '2 days')
       RETURNING id`,
      [organizer, code, access],
    );
    return { id: event?.id ?? "", code };
  };

  const newPlayer = async (email?: string) => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`names_http_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      id,
      email ?? `n${counter}@example.com`,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const dash = (
    method: "GET" | "PUT",
    path: string,
    payload?: object,
    cookie = ownerCookie,
    org = organizer,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${org}${path}`,
      headers: withSession(cookie),
      ...(payload === undefined ? {} : { payload }),
    });

  const join = (token: string, payload: object) =>
    test.app.inject({
      method: "POST",
      url: "/v1/join",
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": freshIp() },
      payload: { via: "code", cardVersion: "0.2", ...payload },
    });
  const card = async (code: string) =>
    (await test.app.inject({ method: "GET", url: `/v1/public/events/${code}` })).json<{
      event: { join: { names: Row } };
      card: { nameNotice: { audience: string; text: { ar: string; en: string } } | null };
    }>();
  const setNames = (event: string, display: string, audience: string, cookie = ownerCookie) =>
    dash("PUT", `/events/${event}/join/names`, { display, audience }, cookie);
  const withNameField = async (event: string): Promise<string> => {
    const setup = (await dash("GET", `/events/${event}/join`)).json<Setup>();
    const saved = await dash("PUT", `/events/${event}/join/fields`, {
      version: setup.version,
      fields: [{ kind: "full_name", required: true }],
    });
    expect(saved.statusCode).toBe(200);
    return saved.json<Setup>().fields[0]?.id ?? "";
  };
  const noticeOf = async (event: string, player: string) =>
    (
      await owner<{ name_notice: string | null }>(
        "SELECT name_notice FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, player],
      )
    )[0];

  describe("the dashboard", () => {
    it("reads usernames for the staff by default and saves the setting for owners and editors", async () => {
      const event = await newEvent();
      expect((await dash("GET", `/events/${event.id}/join`)).json<Setup>().names).toEqual({
        display: "username",
        audience: "staff",
        locked: false,
      });
      await withNameField(event.id);
      const saved = await setNames(event.id, "both", "everyone");
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({
        names: { display: "both", audience: "everyone", locked: false },
      });
      const byEditor = await setNames(event.id, "full_name", "staff", editorCookie);
      expect(byEditor.statusCode).toBe(200);
      expect((await dash("GET", `/events/${event.id}/join`)).json<Setup>().names).toMatchObject({
        display: "full_name",
        audience: "staff",
      });
    });

    it("audits the change with the setting before and after, never a name", async () => {
      const event = await newEvent();
      await withNameField(event.id);
      await setNames(event.id, "both", "staff");
      const [entry] = await owner<{ before: Row; after: Row }>(
        `SELECT before, after FROM audit_log WHERE event_id = $1 AND action = 'event.names.update'`,
        [event.id],
      );
      expect(entry).toEqual({
        before: { display: "username", audience: "staff" },
        after: { display: "both", audience: "staff" },
      });
    });

    it("refuses a full name without the Full name field, an unknown value and another organizer's event", async () => {
      const event = await newEvent();
      const missing = await setNames(event.id, "full_name", "staff");
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toMatchObject({ code: "name_display_needs_full_name" });
      expect((await setNames(event.id, "nickname", "staff")).statusCode).toBe(400);
      expect((await setNames(event.id, "both", "public")).statusCode).toBe(400);
      expect(
        (await dash("PUT", `/events/${event.id}/join/names`, { display: "both" })).statusCode,
      ).toBe(400);
      expect((await setNames(event.id, "username", "staff", otherCookie)).statusCode).toBe(404);
      const anonymous = await test.app.inject({
        method: "PUT",
        url: `/v1/organizers/${organizer}/events/${event.id}/join/names`,
        payload: { display: "username", audience: "staff" },
      });
      expect([401, 403]).toContain(anonymous.statusCode);
    });

    it("refuses to widen once a player who was not told has joined, and says so in the setup", async () => {
      const event = await newEvent();
      const field = await withNameField(event.id);
      const early = await newPlayer();
      const first = await join(early.token, {
        joinCode: event.code,
        answers: { [field]: "Sara Ahmed" },
      });
      expect(first.statusCode).toBe(200);
      const setup = (await dash("GET", `/events/${event.id}/join`)).json<Setup>();
      expect(setup.names.locked).toBe(true);
      const widened = await setNames(event.id, "both", "everyone");
      expect(widened.statusCode).toBe(409);
      expect(widened.json()).toMatchObject({ code: "name_display_locked" });
      expect((await setNames(event.id, "both", "staff")).statusCode).toBe(200);
      expect((await setNames(event.id, "username", "everyone")).statusCode).toBe(200);
    });

    it("keeps the Full name field while full names are shown", async () => {
      const event = await newEvent();
      await withNameField(event.id);
      await setNames(event.id, "full_name", "staff");
      const setup = (await dash("GET", `/events/${event.id}/join`)).json<Setup>();
      const removed = await dash("PUT", `/events/${event.id}/join/fields`, {
        version: setup.version,
        fields: [{ kind: "company", required: false }],
      });
      expect(removed.statusCode).toBe(409);
      expect(removed.json()).toMatchObject({ code: "full_name_field_in_use" });
      await setNames(event.id, "username", "staff");
      const allowed = await dash("PUT", `/events/${event.id}/join/fields`, {
        version: setup.version,
        fields: [{ kind: "company", required: false }],
      });
      expect(allowed.statusCode).toBe(200);
    });
  });

  describe("the card and the join", () => {
    it("says nothing about names for an event that shows usernames", async () => {
      const event = await newEvent();
      expect((await card(event.code)).card.nameNotice).toBeNull();
      expect((await card(event.code)).event.join.names).toEqual({
        display: "username",
        audience: "staff",
      });
    });

    it("tells the audience in both languages and records it with the join", async () => {
      const event = await newEvent();
      const field = await withNameField(event.id);
      await setNames(event.id, "both", "everyone");
      const shown = await card(event.code);
      expect(shown.card.nameNotice).toEqual({
        audience: "everyone",
        text: {
          ar: "يرى جميع اللاعبين في هذه الفعالية اسمك الكامل بجانب اسم المستخدم.",
          en: "Everyone in this event sees your full name next to your username.",
        },
      });
      expect(JSON.stringify(shown)).not.toMatch(/Sara/);
      const player = await newPlayer();
      const joined = await join(player.token, {
        joinCode: event.code,
        nameNotice: "everyone",
        answers: { [field]: " Sara Ahmed " },
      });
      expect(joined.statusCode).toBe(200);
      expect(await noticeOf(event.id, player.id)).toEqual({ name_notice: "everyone" });
    });

    it("tells the staff-only audience apart from everyone", async () => {
      const event = await newEvent();
      await withNameField(event.id);
      await setNames(event.id, "full_name", "staff");
      expect((await card(event.code)).card.nameNotice).toMatchObject({
        audience: "staff",
        text: { en: "Only the event's staff see your full name. Other players see your username." },
      });
    });

    it("refuses a join that did not show the notice, enrolling nobody, and sends the card as it must read", async () => {
      const event = await newEvent();
      const field = await withNameField(event.id);
      await setNames(event.id, "full_name", "everyone");
      const player = await newPlayer();
      for (const payload of [{}, { nameNotice: "staff" }]) {
        const refused = await join(player.token, {
          joinCode: event.code,
          answers: { [field]: "Sara Ahmed" },
          ...payload,
        });
        expect(refused.statusCode, JSON.stringify(payload)).toBe(422);
        expect(refused.json()).toMatchObject({
          code: "card_version_stale",
          details: {
            card: {
              version: "0.2",
              receives: [{}, {}, {}, { en: "Your answers in the fields below" }],
              nameNotice: {
                audience: "everyone",
                text: {
                  en: "Everyone in this event sees your full name instead of your username.",
                },
              },
            },
          },
        });
        expect(await noticeOf(event.id, player.id)).toBeUndefined();
      }
      const ok = await join(player.token, {
        joinCode: event.code,
        nameNotice: "everyone",
        answers: { [field]: "Sara Ahmed" },
      });
      expect(ok.statusCode).toBe(200);
    });

    it("refuses a notice for an event that shows usernames, and a notice the setting changed under the player", async () => {
      const event = await newEvent();
      const field = await withNameField(event.id);
      const player = await newPlayer();
      const stale = await join(player.token, {
        joinCode: event.code,
        nameNotice: "everyone",
        answers: { [field]: "Omar Ali" },
      });
      expect(stale.statusCode).toBe(422);
      expect(stale.json()).toMatchObject({ details: { card: { nameNotice: null } } });
      await setNames(event.id, "both", "staff");
      const changed = await join(player.token, {
        joinCode: event.code,
        nameNotice: "everyone",
        answers: { [field]: "Omar Ali" },
      });
      expect(changed.statusCode).toBe(422);
      expect(changed.json()).toMatchObject({
        details: { card: { nameNotice: { audience: "staff" } } },
      });
      expect(await noticeOf(event.id, player.id)).toBeUndefined();
    });

    it("lets a player who joined already answer without a notice, and records a new one when they come back", async () => {
      const event = await newEvent();
      const field = await withNameField(event.id);
      await setNames(event.id, "both", "staff");
      const player = await newPlayer();
      const first = await join(player.token, {
        joinCode: event.code,
        nameNotice: "staff",
        answers: { [field]: "Sara Ahmed" },
      });
      expect(first.statusCode).toBe(200);
      const again = await join(player.token, { joinCode: event.code, nameNotice: "staff" });
      expect(again.json()).toMatchObject({ alreadyMember: true });
      const left = await test.app.inject({
        method: "POST",
        url: `/v1/events/${event.id}/leave`,
        headers: { authorization: `Bearer ${player.token}` },
      });
      expect(left.statusCode).toBe(204);
      await owner("UPDATE event SET name_display = 'username' WHERE id = $1", [event.id]);
      const back = await join(player.token, {
        joinCode: event.code,
        answers: { [field]: "Sara Ahmed" },
      });
      expect(back.statusCode).toBe(200);
      expect(await noticeOf(event.id, player.id)).toEqual({ name_notice: null });
    });

    it("carries the notice to an invited player's card and records it when they join without a code", async () => {
      const event = await newEvent("private");
      const field = await withNameField(event.id);
      await setNames(event.id, "full_name", "everyone");
      const guest = await newPlayer("guest@invited.test");
      await owner("INSERT INTO event_guest (event_id, kind, value) VALUES ($1, 'email', $2)", [
        event.id,
        "guest@invited.test",
      ]);
      const invitations = await test.app.inject({
        method: "GET",
        url: "/v1/me/invitations",
        headers: { authorization: `Bearer ${guest.token}` },
      });
      const [first] = invitations.json<{ invitations: { card: Row }[] }>().invitations;
      expect(first?.card).toMatchObject({ nameNotice: { audience: "everyone" } });
      const refused = await join(guest.token, {
        via: "invite",
        eventId: event.id,
        answers: { [field]: "Sara Ahmed" },
      });
      expect(refused.statusCode).toBe(422);
      const joined = await join(guest.token, {
        via: "invite",
        eventId: event.id,
        nameNotice: "everyone",
        answers: { [field]: "Sara Ahmed" },
      });
      expect(joined.statusCode).toBe(200);
      expect(await noticeOf(event.id, guest.id)).toEqual({ name_notice: "everyone" });
    });
  });
});
