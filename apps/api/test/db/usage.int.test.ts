import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { sqlstate } from "#test/support/push";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

type Figures = { players: number; invitationsSent: number; alertEmails: number };
type OrganizerUsage = Figures & { id: string; name: string; events: number };
type EventUsage = Figures & {
  id: string;
  name: { ar: string | null; en: string | null };
  status: string;
};

/**
 * The console's usage doors (T-609, FR-1730, migration 0104, ADR-394): counts per organizer and per event from rows
 * that already exist, for a platform admin only; every other seat is refused with US404 and learns nothing.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("usage view (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};
  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('usage@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
  });
  afterAll(async () => {
    await f.close();
  });

  const organizers = async () =>
    (
      await f.run<{ r: { organizers: OrganizerUsage[] } }>(admin, "SELECT usage_organizers() AS r")
    )[0]?.r.organizers ?? [];
  const eventsOf = async (organizer: string) =>
    (
      await f.run<{ r: { organizer: { id: string; name: string }; events: EventUsage[] } }>(
        admin,
        "SELECT usage_events($1) AS r",
        [organizer],
      )
    )[0]?.r;

  const newOrganizer = async () => {
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Usage Org', $1) RETURNING id",
      [`usage-${randomUUID().slice(0, 8)}`],
    );
    return made?.id ?? "";
  };
  const campaign = (organizer: string, event: string, sent: number) =>
    f.owner(
      `INSERT INTO invitation_campaign (organizer_id, event_id, request_id, fingerprint, size, sent)
       VALUES ($1, $2, gen_random_uuid(), 'x', 50, $3)`,
      [organizer, event, sent],
    );
  const alert = (organizer: string, event: string | null, state: string) =>
    f.owner(
      `INSERT INTO organizer_alert (organizer_id, event_id, staff_user_id, alert_type, dedupe, state, finished_at)
       VALUES ($1, $2, gen_random_uuid(), 'activated', $3, $4, CASE WHEN $4 = 'queued' THEN NULL ELSE now() END)`,
      [organizer, event, randomUUID(), state],
    );

  it("counts an organizer's events, players, invitations and alert emails, and each event's own", async () => {
    const org = await newOrganizer();
    const busy = await f.newEvent({ phase: "live", organizer: org });
    const quiet = await f.newEvent({ phase: "scheduled", organizer: org });
    for (const via of [null, null, "rehearsal"]) await f.join(busy, await f.newPlayer(), via);
    const pending = await f.join(busy, await f.newPlayer());
    await f.owner("UPDATE enrollment SET status = 'pending' WHERE id = $1", [pending]);
    await campaign(org, busy, 40);
    await alert(org, busy, "sent");
    await alert(org, busy, "sent");
    await alert(org, null, "sent");
    await alert(org, busy, "skipped");
    await alert(org, busy, "queued");

    expect((await organizers()).find((row) => row.id === org)).toEqual({
      id: org,
      name: "Usage Org",
      events: 2,
      players: 2,
      invitationsSent: 40,
      alertEmails: 3,
    });
    const usage = await eventsOf(org);
    expect(usage?.organizer).toEqual({ id: org, name: "Usage Org" });
    expect(usage?.events.map((row) => [row.id, row.status, row.players])).toEqual(
      expect.arrayContaining([
        [busy, "live", 2],
        [quiet, "scheduled", 0],
      ]),
    );
    expect(usage?.events.find((row) => row.id === busy)).toMatchObject({
      name: { ar: "فعالية", en: expect.stringMatching(/^Event /) },
      invitationsSent: 40,
      alertEmails: 2,
    });
    expect(usage?.events.find((row) => row.id === quiet)).toMatchObject({
      invitationsSent: 0,
      alertEmails: 0,
    });
  });

  it("lists the organizers created last, newest first, 100 at most", async () => {
    for (let n = 0; n < 3; n += 1) await newOrganizer();
    const rows = await organizers();
    expect(rows.length).toBeLessThanOrEqual(100);
    const created = await f.owner<{ id: string }>(
      "SELECT id FROM organizer ORDER BY created_at DESC, id LIMIT 3",
    );
    expect(rows.slice(0, 3).map((row) => row.id)).toEqual(created.map((row) => row.id));
  });

  it("answers an unknown organizer with US404", async () => {
    expect(await sqlstate(f.run(admin, "SELECT usage_events($1)", [randomUUID()]))).toBe("US404");
  });

  it("refuses every seat that is not an active platform admin, and reads nothing for it", async () => {
    const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
    const [disabled] = await f.owner<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ('usage-off@questify.test', 'h', 'admin', 'disabled') RETURNING id`,
    );
    const seats: RequestContext[] = [
      f.team(),
      f.team(editor),
      { playerId: await f.newPlayer() },
      { isAdmin: true },
      { isAdmin: true, staffUserId: editor },
      { isAdmin: true, staffUserId: disabled?.id ?? "" },
      {},
    ];
    for (const seat of seats) {
      for (const call of ["SELECT usage_organizers()", `SELECT usage_events('${f.ids.orgA}')`]) {
        expect(await sqlstate(f.run(seat, call)), `${call} ${JSON.stringify(seat)}`).toBe("US404");
      }
    }
  });
});
