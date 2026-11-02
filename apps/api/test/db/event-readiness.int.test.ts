import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Facts = {
  status: string;
  dates: string;
  activation: string;
  quests: { total: number; playable: number; stationOnly: number; deviceOnly: number };
  rewards: { active: number; inStock: number; items: number; experiences: number };
  desk: { place: boolean };
  operators: number;
  devices: { stations: number; kiosks: number; screens: number };
  join: { access: string; guestListOnly: boolean; guests: number };
  rules: boolean;
  bigScreen: boolean;
  rehearsed: boolean;
  branding: boolean;
  setup: { decided: number; finished: boolean };
};
type Soon = { events: { id: string; organizer: { id: string; name: string }; facts: Facts }[] };

/** A call's SQLSTATE, or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

/**
 * The go-live checklist's facts in the database (T-618, migration 0112): flags and counts over rows other pages write,
 * for the event's own team (event_readiness) and for a Questify admin (readiness_soon); nobody else reads them.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event readiness (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};
  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('ready@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
  });
  afterAll(async () => {
    await f.close();
  });

  const facts = async (ev: string, seat = f.team()): Promise<Facts> =>
    (await f.run<{ answer: Facts }>(seat, "SELECT event_readiness($1) AS answer", [ev]))[0]
      ?.answer as Facts;
  const soon = async (seat: RequestContext = admin): Promise<Soon> =>
    (await f.run<{ answer: Soon }>(seat, "SELECT readiness_soon() AS answer"))[0]?.answer as Soon;
  /** A scheduled event with no prize desk place, so each test starts from nothing set. */
  const bareEvent = async (): Promise<string> => {
    const ev = await f.newEvent({ phase: "scheduled" });
    await f.owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [ev]);
    return ev;
  };
  const organizerOf = async (ev: string): Promise<string> =>
    (
      await f.owner<{ organizer_id: string }>("SELECT organizer_id FROM event WHERE id = $1", [ev])
    )[0]?.organizer_id ?? "";
  type QuestOptions = Readonly<{
    visible?: boolean;
    verification?: string[];
    pausedAt?: boolean;
    skippedAt?: boolean;
    closed?: boolean;
    deleted?: boolean;
  }>;
  const quest = async (ev: string, options: QuestOptions = {}): Promise<string> => {
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, verification,
                          paused_at, paused_by, skipped_at, skipped_by, closes_at, deleted_at, deleted_by)
       SELECT $1, id, 'scan_qr', 'Quest', 10, 1, $2, $3::text[],
              CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN $8::uuid END,
              CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $8::uuid END,
              CASE WHEN $6 THEN now() - interval '1 hour' END,
              CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN $8::uuid END
       FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [
        ev,
        options.visible ?? options.deleted !== true,
        options.verification ?? ["quest_qr"],
        options.pausedAt ?? false,
        options.skippedAt ?? false,
        options.closed ?? false,
        options.deleted ?? false,
        f.ownerA,
      ],
    );
    return row?.id ?? "";
  };
  const reward = async (
    ev: string,
    kind: string,
    options: Readonly<{ stock?: number; out?: number; status?: string; closed?: boolean }> = {},
  ) =>
    f.owner(
      `INSERT INTO reward (organizer_id, event_id, kind, name_en, price, stock_total, units_out, status, closes_at)
       VALUES ($1, $2, $3, 'Prize', 10, $4, $5, $6,
               CASE WHEN $7 THEN now() - interval '1 hour' END)`,
      [
        await organizerOf(ev),
        ev,
        kind,
        options.stock ?? 5,
        options.out ?? 0,
        options.status ?? "active",
        options.closed ?? false,
      ],
    );
  const device = async (ev: string, kind: string, status = "active") => {
    const questId = kind === "screen" ? null : await quest(ev);
    return f.owner(
      `INSERT INTO paired_device (organizer_id, event_id, kind, quest_id, label, secret_hash, status,
                                 paired_by_staff, revoked_at)
       VALUES ($1, $2, $3, $4, 'Device', decode(md5(random()::text) || md5(random()::text), 'hex'), $5, $6,
               CASE WHEN $5 = 'revoked' THEN now() END)`,
      [await organizerOf(ev), ev, kind, questId, status, f.ownerA],
    );
  };

  it("reads a bare event as nothing set", async () => {
    const ev = await bareEvent();
    expect(await facts(ev)).toEqual({
      status: "scheduled",
      dates: "set",
      activation: "none",
      quests: { total: 0, playable: 0, stationOnly: 0, deviceOnly: 0 },
      rewards: { active: 0, inStock: 0, items: 0, experiences: 0 },
      desk: { place: false },
      operators: 0,
      devices: { stations: 0, kiosks: 0, screens: 0 },
      join: { access: "public", guestListOnly: false, guests: 0 },
      rules: false,
      bigScreen: false,
      rehearsed: false,
      branding: false,
      setup: { decided: 0, finished: false },
    });
  });

  it("reads missing and past dates", async () => {
    const [draft] = await f.owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'RDYDRAFT1', 'Draft', 'draft')
       RETURNING id`,
      [f.ids.orgA],
    );
    const ev = draft?.id ?? "";
    expect((await facts(ev)).dates).toBe("missing");
    expect((await facts(ev)).status).toBe("draft");
    await f.owner(
      "UPDATE event SET starts_at = now() - interval '3 days', ends_at = now() - interval '2 days' WHERE id = $1",
      [ev],
    );
    expect((await facts(ev)).dates).toBe("past");
  });

  it("reads the activation as none, pending, rejected and active", async () => {
    const ev = await bareEvent();
    const organizer = await organizerOf(ev);
    expect((await facts(ev)).activation).toBe("none");
    await f.owner(
      "INSERT INTO event_activation_request (event_id, organizer_id, state, requested_by) VALUES ($1, $2, 'pending', $3)",
      [ev, organizer, f.ownerA],
    );
    expect((await facts(ev)).activation).toBe("pending");
    await f.owner(
      `UPDATE event_activation_request SET state = 'rejected', note = 'Add dates', decided_by = $2, decided_at = now()
       WHERE event_id = $1`,
      [ev, f.ownerA],
    );
    expect((await facts(ev)).activation).toBe("rejected");
    await f.owner("UPDATE event SET activated_at = now() WHERE id = $1", [ev]);
    expect((await facts(ev)).activation).toBe("active");
  });

  it("counts playable quests apart from hidden, paused, skipped, closed and removed ones", async () => {
    const ev = await bareEvent();
    await quest(ev);
    await quest(ev, { verification: ["my_qr"] });
    await quest(ev, { verification: ["kiosk"] });
    await quest(ev, { verification: ["screen_qr", "kiosk"] });
    await quest(ev, { verification: ["quest_qr", "kiosk"] });
    await quest(ev, { visible: false, verification: ["my_qr"] });
    await quest(ev, { pausedAt: true });
    await quest(ev, { skippedAt: true });
    await quest(ev, { closed: true });
    await quest(ev, { deleted: true });
    expect((await facts(ev)).quests).toEqual({
      total: 9,
      playable: 5,
      stationOnly: 1,
      deviceOnly: 2,
    });
  });

  it("counts active rewards, those in stock inside their window, and item and experience rewards", async () => {
    const ev = await bareEvent();
    await reward(ev, "item");
    await reward(ev, "experience", { stock: 3, out: 3 });
    await reward(ev, "digital", { closed: true });
    await reward(ev, "item", { status: "removed" });
    expect((await facts(ev)).rewards).toEqual({ active: 3, inStock: 1, items: 1, experiences: 1 });
  });

  it("reads a prize desk place in either language", async () => {
    const ev = await bareEvent();
    await f.owner("UPDATE event SET desk_location_ar = 'القاعة ب' WHERE id = $1", [ev]);
    expect((await facts(ev)).desk.place).toBe(true);
    await f.owner(
      "UPDATE event SET desk_location_ar = NULL, desk_location_en = 'Hall B' WHERE id = $1",
      [ev],
    );
    expect((await facts(ev)).desk.place).toBe(true);
  });

  it("counts operators and the devices that are not revoked", async () => {
    const ev = await bareEvent();
    for (let i = 0; i < 2; i += 1) {
      await f.owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [await organizerOf(ev), ev, await f.newPlayer()],
      );
    }
    await device(ev, "station");
    await device(ev, "kiosk");
    await device(ev, "kiosk", "revoked");
    await device(ev, "screen");
    const found = await facts(ev);
    expect(found.operators).toBe(2);
    expect(found.devices).toEqual({ stations: 1, kiosks: 1, screens: 1 });
  });

  it("reads how players join: access, a guest list and its size", async () => {
    const ev = await bareEvent();
    await f.owner("UPDATE event SET access = 'private', guest_list_only = true WHERE id = $1", [
      ev,
    ]);
    await f.owner(
      "INSERT INTO event_guest (organizer_id, event_id, kind, value) VALUES ($1, $2, 'email', 'guest@x.test')",
      [await organizerOf(ev), ev],
    );
    expect((await facts(ev)).join).toEqual({ access: "private", guestListOnly: true, guests: 1 });
  });

  it("reads rules in either language, the accent, the big screen and the guided setup", async () => {
    const ev = await bareEvent();
    const organizer = await organizerOf(ev);
    await f.owner("UPDATE event SET rules_ar = 'القواعد' WHERE id = $1", [ev]);
    expect((await facts(ev)).rules).toBe(true);
    await f.owner(
      "UPDATE event SET config = jsonb_set(config, '{branding}', '{\"accent\": \"teal\"}') WHERE id = $1",
      [ev],
    );
    expect((await facts(ev)).branding).toBe(true);
    await f.owner(
      "UPDATE event SET config = jsonb_set(config, '{branding}', '{\"accent\": null}') WHERE id = $1",
      [ev],
    );
    expect((await facts(ev)).branding).toBe(false);
    await f.owner(
      "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
      [ev, organizer],
    );
    expect((await facts(ev)).bigScreen).toBe(true);
    await f.owner(
      "UPDATE event SET config = jsonb_set(config, '{features}', '{\"bigScreen\": false}') WHERE id = $1",
      [ev],
    );
    expect((await facts(ev)).bigScreen).toBe(false);
    await f.owner(
      "INSERT INTO event_setup (event_id, organizer_id, current_step, steps, updated_by) VALUES ($1, $2, 4, 'ddsnnnnnnn', $3)",
      [ev, organizer, f.ownerA],
    );
    expect((await facts(ev)).setup).toEqual({ decided: 3, finished: false });
    await f.owner("UPDATE event_setup SET finished_at = now() WHERE event_id = $1", [ev]);
    expect((await facts(ev)).setup.finished).toBe(true);
  });

  it("reads a rehearsal from the kept first play or from a rehearsal entry, before go-live only", async () => {
    const ev = await bareEvent();
    expect((await facts(ev)).rehearsed).toBe(false);
    const real = await f.join(ev, await f.newPlayer());
    await f.earn(ev, real);
    expect((await facts(ev)).rehearsed).toBe(false);
    const rehearsing = await f.join(ev, await f.newPlayer(), "rehearsal");
    await f.earn(ev, rehearsing);
    expect((await facts(ev)).rehearsed).toBe(true);
    await f.owner(
      "UPDATE event SET status = 'live', starts_at = now() - interval '1 hour' WHERE id = $1",
      [ev],
    );
    expect((await facts(ev)).rehearsed).toBe(false);

    const kept = await bareEvent();
    await f.owner(
      "INSERT INTO event_rehearsal (event_id, organizer_id, code, first_play_at) VALUES ($1, $2, 'ABCD-EFGH', now())",
      [kept, await organizerOf(kept)],
    );
    await f.owner(
      "UPDATE event SET status = 'live', starts_at = now() - interval '1 hour' WHERE id = $1",
      [kept],
    );
    const found = await facts(kept);
    expect(found.rehearsed).toBe(true);
    expect(found.status).toBe("live");
  });

  it("answers the team of the event only: another organizer, a player and no seat are refused with AN404", async () => {
    const ev = await bareEvent();
    const stranger = await addMember(f.db.owner, f.ids.orgB, "owner");
    for (const seat of [
      f.team(stranger, f.ids.orgB),
      f.team(f.ownerA, f.ids.orgB),
      { playerId: await f.newPlayer() },
      {},
    ]) {
      expect(await refusal(f.run(seat, "SELECT event_readiness($1)", [ev]))).toBe("AN404");
    }
  });

  it("answers an editor inside their event limit and refuses one outside it", async () => {
    const ev = await bareEvent();
    const other = await bareEvent();
    const editor = await addMember(f.db.owner, f.ids.orgA, "editor", [ev]);
    expect((await facts(ev, f.team(editor))).status).toBe("scheduled");
    expect(await refusal(f.run(f.team(editor), "SELECT event_readiness($1)", [other]))).toBe(
      "AN404",
    );
  });

  it("answers an unknown event with AN404", async () => {
    expect(await refusal(f.run(f.team(), "SELECT event_readiness(gen_random_uuid())"))).toBe(
      "AN404",
    );
  });

  it("lists, for an admin, the events that start within 14 days and are not live, soonest first, with the facts", async () => {
    const tomorrow = await bareEvent();
    await quest(tomorrow);
    const later = await bareEvent();
    await f.owner(
      "UPDATE event SET starts_at = now() + interval '10 days', ends_at = now() + interval '11 days' WHERE id = $1",
      [later],
    );
    const far = await bareEvent();
    await f.owner(
      "UPDATE event SET starts_at = now() + interval '30 days', ends_at = now() + interval '31 days' WHERE id = $1",
      [far],
    );
    const live = await f.newEvent({ phase: "live" });
    const ended = await f.newEvent({ phase: "ended" });
    const [draft] = await f.owner<{ id: string }>(
      "INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'RDYSOON9', 'No dates', 'draft') RETURNING id",
      [f.ids.orgA],
    );
    const overdue = await bareEvent();
    await f.owner(
      "UPDATE event SET starts_at = now() - interval '2 hours', ends_at = now() + interval '1 day' WHERE id = $1",
      [overdue],
    );

    const list = (await soon()).events;
    const ids = list.map((entry) => entry.id);
    expect(ids).toContain(tomorrow);
    expect(ids).toContain(later);
    expect(ids).toContain(overdue);
    for (const excluded of [far, live, ended, draft?.id ?? ""]) {
      expect(ids).not.toContain(excluded);
    }
    expect(ids.indexOf(overdue)).toBeLessThan(ids.indexOf(tomorrow));
    expect(ids.indexOf(tomorrow)).toBeLessThan(ids.indexOf(later));
    const row = list.find((entry) => entry.id === tomorrow);
    expect(row?.organizer).toEqual({ id: f.ids.orgA, name: "Najd Events" });
    expect(row?.facts.quests.total).toBe(1);
  });

  it("lists events of every organizer to an admin, and refuses everyone else with RD404", async () => {
    const mine = await bareEvent();
    const theirs = await f.newEvent({ phase: "scheduled", organizer: f.ids.orgB });
    const ids = (await soon()).events.map((entry) => entry.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(theirs);
    const member = f.team();
    const notAdmin = { isAdmin: true, staffUserId: f.ownerA };
    for (const seat of [member, notAdmin, { playerId: await f.newPlayer() }, {}]) {
      expect(await refusal(f.run(seat, "SELECT readiness_soon()"))).toBe("RD404");
    }
  });

  it("keeps the internal facts function out of every role's reach", async () => {
    const ev = await bareEvent();
    for (const seat of [admin, f.team(), {}]) {
      expect(await refusal(f.run(seat, "SELECT readiness_facts($1)", [ev]))).toBe("42501");
    }
  });
});
