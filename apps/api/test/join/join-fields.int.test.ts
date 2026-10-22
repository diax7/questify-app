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

/**
 * Join fields, the guest list, the locks and the welcome reward over HTTP (T-212): the dashboard sets them up, the
 * card shows them, the join checks them, and only the event's team reads the answers.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("join fields and locks over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let otherOrganizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let otherCookie: string;
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
    organizer = await made("fields-org");
    otherOrganizer = await made("fields-other");
    const ownerId = await createStaff(db.owner, { email: "owner@fields.test" });
    const editorId = await createStaff(db.owner, { email: "editor@fields.test" });
    const otherId = await createStaff(db.owner, { email: "owner@other.test" });
    await db.owner.query(
      `INSERT INTO organizer_member (organizer_id, staff_user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'editor'), ($4, $5, 'owner')`,
      [organizer, ownerId, editorId, otherOrganizer, otherId],
    );
    ownerCookie = await signInFully(test, "owner@fields.test");
    editorCookie = await signInFully(test, "editor@fields.test");
    otherCookie = await signInFully(test, "owner@other.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (
    spec: { status?: string; startsIn?: string; access?: string } = {},
  ): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `FLD${counter}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, $2, 'Field Fest', $3, $4, now() + $5::interval, now() + interval '2 days') RETURNING id`,
      [organizer, code, spec.status ?? "live", spec.access ?? "public", spec.startsIn ?? "-1 hour"],
    );
    return { id: event?.id ?? "", code };
  };

  const newPlayer = async (contact: { phone?: string; email?: string } = {}) => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`fields_http_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      contact.phone ?? null,
      contact.email ?? (contact.phone === undefined ? `f${counter}@example.com` : null),
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const dash = (
    method: "GET" | "PUT" | "POST" | "DELETE",
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

  type Setup = { version: number; fields: { id: string; kind: string }[] };

  const saveFields = async (event: string, fields: object[], cookie = ownerCookie) => {
    const setup = (await dash("GET", `/events/${event}/join`, undefined, cookie)).json<Setup>();
    return dash("PUT", `/events/${event}/join/fields`, { version: setup.version, fields }, cookie);
  };

  describe("the dashboard", () => {
    it("saves the field list in order for owners and editors, versioned against stale pages", async () => {
      const event = await newEvent();
      const first = await saveFields(
        event.id,
        [
          { kind: "full_name", required: true },
          { kind: "custom", label: { ar: " القسم ", en: "Section" }, required: false },
        ],
        editorCookie,
      );
      expect(first.statusCode).toBe(200);
      const saved = first.json<Setup & { fields: Row[] }>();
      expect(saved.version).toBe(1);
      expect(saved.fields).toMatchObject([
        { kind: "full_name", required: true, label: { ar: null, en: null } },
        { kind: "custom", required: false, label: { ar: "القسم", en: "Section" } },
      ]);

      const custom = saved.fields[1]?.["id"];
      const reordered = await dash("PUT", `/events/${event.id}/join/fields`, {
        version: 1,
        fields: [{ id: custom, kind: "custom", label: { en: "Wing" }, required: true }],
      });
      expect(reordered.json<Setup>().fields).toEqual([
        { id: custom, kind: "custom", label: { ar: null, en: "Wing" }, required: true },
      ]);
      const stale = await dash("PUT", `/events/${event.id}/join/fields`, {
        version: 1,
        fields: [],
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "join_fields_changed" });
      expect(
        await owner("SELECT action FROM audit_log WHERE event_id = $1 ORDER BY id", [event.id]),
      ).toEqual([{ action: "event.join_fields.update" }, { action: "event.join_fields.update" }]);
    });

    it("refuses a list that breaks a rule, and another organizer's event", async () => {
      const event = await newEvent();
      for (const fields of [
        [
          { kind: "company", required: true },
          { kind: "company", required: false },
        ],
        [{ kind: "custom", required: true }],
        [{ kind: "custom", label: { en: "x".repeat(61) }, required: true }],
        [{ id: "00000000-0000-4000-8000-000000000000", kind: "company", required: true }],
      ]) {
        const refused = await saveFields(event.id, fields);
        expect(refused.statusCode, JSON.stringify(fields)).toBe(400);
      }
      const six = Array.from({ length: 6 }, (_, n) => ({
        kind: "custom",
        label: { en: `F${n}` },
        required: false,
      }));
      expect((await saveFields(event.id, six)).statusCode).toBe(400);
      expect(
        (await dash("GET", `/events/${event.id}/join`, undefined, otherCookie, otherOrganizer))
          .statusCode,
      ).toBe(404);
      expect(
        (await dash("GET", `/events/${event.id}/join`, undefined, otherCookie)).statusCode,
      ).toBe(404);
    });

    it("refuses changing a kept field's kind", async () => {
      const event = await newEvent();
      const saved = (
        await saveFields(event.id, [{ kind: "company", required: true }])
      ).json<Setup>();
      const changed = await dash("PUT", `/events/${event.id}/join/fields`, {
        version: saved.version,
        fields: [{ id: saved.fields[0]?.id, kind: "department", required: true }],
      });
      expect(changed.statusCode).toBe(400);
    });

    it("sets the locks and the welcome, fixed once anyone joined", async () => {
      const event = await newEvent({ status: "scheduled", startsIn: "1 day" });
      const set = await dash("PUT", `/events/${event.id}/join/rules`, {
        guestListOnly: true,
        emailDomains: ["@ACME.sa", "acme.sa", "acme.com"],
        welcomePoints: 50,
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({
        rules: { guestListOnly: true, emailDomains: ["acme.sa", "acme.com"], welcomePoints: 50 },
      });
      expect(
        (await dash("PUT", `/events/${event.id}/join/rules`, { emailDomains: ["not a domain"] }))
          .statusCode,
      ).toBe(400);
      await owner("UPDATE event SET guest_list_only = false, email_domains = '{}' WHERE id = $1", [
        event.id,
      ]);
      const player = await newPlayer();
      expect((await join(player.token, { joinCode: event.code })).json()).toMatchObject({
        welcome: 50,
      });
      const setup = await dash("GET", `/events/${event.id}/join`);
      expect(setup.json()).toMatchObject({ welcomeLocked: true, rules: { welcomePoints: 50 } });
      const locked = await dash("PUT", `/events/${event.id}/join/rules`, { welcomePoints: 60 });
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ code: "setting_locked" });
      expect(
        (
          await dash("PUT", `/events/${event.id}/join/rules`, {
            welcomePoints: 50,
            guestListOnly: true,
          })
        ).statusCode,
      ).toBe(200);
    });

    it("uploads a guest list, reports the invalid lines, masks the entries and removes one", async () => {
      const event = await newEvent();
      const added = await dash("POST", `/events/${event.id}/join/guests`, {
        lines: ["0512345678", "+966 51 234 5678", "Guest@Acme.sa", "", "not a contact", "a@b"],
      });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toEqual({
        added: 2,
        existing: 0,
        invalid: [
          { line: 5, text: "not a contact" },
          { line: 6, text: "a@b" },
        ],
        total: 2,
      });
      const again = await dash("POST", `/events/${event.id}/join/guests`, {
        lines: ["guest@acme.sa"],
      });
      expect(again.json()).toMatchObject({ added: 0, existing: 1, total: 2 });
      const list = await dash("GET", `/events/${event.id}/join/guests`, undefined, editorCookie);
      const body = list.json<{ total: number; guests: { id: string; value: string }[] }>();
      expect(body.total).toBe(2);
      expect(body.guests.map((guest) => guest.value).toSorted()).toEqual(
        ["g•••@acme.sa", "•••• 5678"].toSorted(),
      );
      const audit = await owner<{ after: Row }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.guests.add'",
        [event.id],
      );
      expect(JSON.stringify(audit)).not.toContain("acme");
      const first = body.guests[0]?.id ?? "";
      expect((await dash("DELETE", `/events/${event.id}/join/guests/${first}`)).statusCode).toBe(
        204,
      );
      expect((await dash("DELETE", `/events/${event.id}/join/guests/${first}`)).statusCode).toBe(
        404,
      );
    });

    it("refuses an upload that would pass 10 000, adding nothing", async () => {
      const event = await newEvent();
      await owner(
        `INSERT INTO event_guest (event_id, kind, value)
         SELECT $1, 'email', 'g' || n || '@bulk.sa' FROM generate_series(1, 9999) n`,
        [event.id],
      );
      const full = await dash("POST", `/events/${event.id}/join/guests`, {
        lines: ["one@bulk2.sa", "two@bulk2.sa"],
      });
      expect(full.statusCode).toBe(409);
      expect(full.json()).toMatchObject({ code: "guest_list_full", details: { room: 1 } });
    });
  });

  describe("the card and the join", () => {
    it("shows the fields and locks on the card and needs every required answer", async () => {
      const event = await newEvent();
      const saved = (
        await saveFields(event.id, [
          { kind: "company", required: true },
          { kind: "ticket_number", required: false },
        ])
      ).json<Setup>();
      const [company, ticket] = saved.fields.map((field) => field.id);
      const card = await test.app.inject({ method: "GET", url: `/v1/public/events/${event.code}` });
      expect(card.json()).toMatchObject({
        event: {
          join: {
            guestListOnly: false,
            emailDomains: [],
            welcomePoints: null,
            fields: [
              { id: company, kind: "company", required: true },
              { id: ticket, kind: "ticket_number", required: false },
            ],
          },
        },
        card: {
          version: "0.2",
          receives: [{}, {}, {}, { en: "Your answers in the fields below" }],
        },
      });

      const player = await newPlayer();
      const missing = await join(player.token, {
        joinCode: event.code,
        answers: { [company ?? ""]: "   ", [ticket ?? ""]: "T-1" },
      });
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toMatchObject({
        code: "invalid_join_answers",
        details: { field: company },
      });
      const joined = await join(player.token, {
        joinCode: event.code,
        answers: { [company ?? ""]: "  Acme  ", [ticket ?? ""]: "" },
      });
      expect(joined.statusCode).toBe(200);
      expect(joined.json()).toMatchObject({ status: "active", alreadyMember: false, welcome: 0 });

      const list = await dash("GET", `/events/${event.id}/players`, undefined, editorCookie);
      expect(list.json<{ players: Row[] }>().players[0]?.["answers"]).toEqual([
        { fieldId: company, kind: "company", label: { ar: null, en: null }, value: "Acme" },
      ]);
    });

    it("refuses with the event's own reason: by invitation, or the domains it takes", async () => {
      const inviteOnly = await newEvent();
      await dash("PUT", `/events/${inviteOnly.id}/join/rules`, { guestListOnly: true });
      const domains = await newEvent();
      await dash("PUT", `/events/${domains.id}/join/rules`, { emailDomains: ["acme.sa"] });
      const player = await newPlayer({ email: "someone@other.sa" });
      const refused = await join(player.token, { joinCode: inviteOnly.code });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "join_invite_only" });
      const wrong = await join(player.token, { joinCode: domains.code });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({
        code: "join_domain_required",
        details: { domains: ["acme.sa"] },
        message: { en: "This event takes a verified email at: @acme.sa" },
      });
    });

    it("lists invitations and joins one without a code; the body names one way in", async () => {
      const event = await newEvent({ access: "private" });
      await dash("POST", `/events/${event.id}/join/guests`, { lines: ["0598765432"] });
      const guest = await newPlayer({ phone: "+966598765432" });
      const auth = { authorization: `Bearer ${guest.token}` };
      const invitations = await test.app.inject({
        method: "GET",
        url: "/v1/me/invitations",
        headers: auth,
      });
      expect(invitations.statusCode).toBe(200);
      const [first] = invitations.json<{ invitations: { event: Row; card: Row }[] }>().invitations;
      expect(first?.event).toMatchObject({ id: event.id, access: "private" });
      expect(Object.keys(first?.event ?? {})).not.toContain("joinCode");
      expect(first?.card).toMatchObject({ version: "0.2" });

      for (const payload of [
        { via: "invite", joinCode: event.code, eventId: event.id },
        { via: "invite" },
        { via: "code", eventId: event.id },
      ]) {
        expect((await join(guest.token, payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
      const stranger = await newPlayer();
      expect((await join(stranger.token, { via: "invite", eventId: event.id })).statusCode).toBe(
        404,
      );
      const joined = await join(guest.token, { via: "invite", eventId: event.id });
      expect(joined.json()).toMatchObject({ eventId: event.id, status: "active" });
      expect(
        (await test.app.inject({ method: "GET", url: "/v1/me/invitations", headers: auth })).json(),
      ).toEqual({ invitations: [] });
      expect((await test.app.inject({ method: "GET", url: "/v1/me/invitations" })).statusCode).toBe(
        401,
      );
    });
  });
});
