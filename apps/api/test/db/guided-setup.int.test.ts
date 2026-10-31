import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/** A call's SQLSTATE, or "none" when it succeeds. */
const sqlState = async (work: Promise<unknown>) =>
  work.then(
    () => "none",
    (error: { code?: string }) => error.code,
  );

/**
 * The guided setup table (T-605, migration 0100): progress is visible and writable only to an owner or an editor of the
 * event's organizer inside the event limit, never to a player, a stranger or the public role; the ten step letters and
 * the step number are checked by the database; a row cannot move to another event or organizer, is never deleted by
 * the API's role, and goes with its event.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("guided setup table", () => {
  let db: TestDatabase;
  let orgA = "";
  let orgB = "";
  let eventA = "";
  let eventB = "";
  let staffA = "";
  let staffB = "";
  let playerA = "";

  const as = <T>(context: RequestContext, work: () => Promise<T>) =>
    withRequestContext(db.app, context, work);
  const seatA = (): RequestContext => ({ organizerId: orgA, staffUserId: staffA });
  const insert = (
    context: RequestContext,
    row: Readonly<{
      organizer?: string;
      event?: string;
      by?: string;
      steps?: string;
      step?: number;
    }>,
  ) =>
    as(context, () =>
      sqlState(
        db.app.query(
          `INSERT INTO event_setup (event_id, organizer_id, current_step, steps, updated_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            row.event ?? eventA,
            row.organizer ?? orgA,
            row.step ?? 1,
            row.steps ?? "nnnnnnnnnn",
            row.by ?? staffA,
          ],
        ),
      ),
    );
  const clear = () => db.owner.query("DELETE FROM event_setup");
  const seed = (event = eventA, organizer = orgA, by = staffA) =>
    db.owner.query(
      "INSERT INTO event_setup (event_id, organizer_id, updated_by) VALUES ($1, $2, $3)",
      [event, organizer, by],
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ orgA, orgB, eventA, eventB, playerA } = await seedTwoTenants(db.owner));
    const staff = async (email: string, organizer: string) => {
      const { rows } = await db.owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [email],
      );
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
        [organizer, rows[0]?.id],
      );
      return rows[0]?.id ?? "";
    };
    staffA = await staff("a@setup.test", orgA);
    staffB = await staff("b@setup.test", orgB);
  });
  afterAll(async () => {
    await db.close();
  });

  it("shows progress to its organizer's staff only, and to no player, stranger or public role", async () => {
    await clear();
    await seed();
    const seen = (context: RequestContext) =>
      as(context, async () => (await db.app.query("SELECT 1 FROM event_setup")).rowCount);
    expect(await seen(seatA())).toBe(1);
    expect(await seen({ organizerId: orgB, staffUserId: staffB })).toBe(0);
    expect(await seen({ organizerId: orgA, playerId: playerA })).toBe(0);
    expect(await seen({ playerId: playerA })).toBe(0);
    expect(await seen({})).toBe(0);
    await expect(db.outsider.query("SELECT 1 FROM public.event_setup")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("lets the owner's seat write its own event's progress and nobody else's", async () => {
    await clear();
    expect(await insert(seatA(), {})).toBe("none");
    await clear();
    expect(await insert(seatA(), { organizer: orgB, event: eventB, by: staffA })).toBe("42501");
    expect(await insert(seatA(), { event: eventB })).toBe("23503");
    expect(await insert({ organizerId: orgA, playerId: playerA }, {})).toBe("42501");
    expect(await insert({ playerId: playerA }, {})).toBe("42501");
    expect(await insert({ organizerId: orgB, staffUserId: staffB }, {})).toBe("42501");
  });

  it("refuses a row that names another staff member as its author", async () => {
    await clear();
    expect(await insert(seatA(), { by: staffB })).toBe("42501");
  });

  it("checks the ten step letters and the step number in the database", async () => {
    await clear();
    expect(await insert(seatA(), { steps: "nnnnnnnnn" })).toBe("23514");
    expect(await insert(seatA(), { steps: "nnnnnnnnnnn" })).toBe("23514");
    expect(await insert(seatA(), { steps: "nnnnxnnnnn" })).toBe("23514");
    expect(await insert(seatA(), { steps: "NNNNNNNNNN" })).toBe("23514");
    expect(await insert(seatA(), { step: 0 })).toBe("23514");
    expect(await insert(seatA(), { step: 11 })).toBe("23514");
    expect(await insert(seatA(), { step: 10, steps: "dsdsdsdsdn" })).toBe("none");
  });

  it("updates only the progress columns and never deletes", async () => {
    await clear();
    await seed();
    const update = (sql: string) => as(seatA(), () => sqlState(db.app.query(sql, [eventA])));
    expect(
      await update(
        "UPDATE event_setup SET current_step = 5, steps = 'dddsnnnnnn' WHERE event_id = $1",
      ),
    ).toBe("none");
    expect(
      await update("UPDATE event_setup SET event_id = gen_random_uuid() WHERE event_id = $1"),
    ).toBe("42501");
    expect(
      await update("UPDATE event_setup SET organizer_id = gen_random_uuid() WHERE event_id = $1"),
    ).toBe("42501");
    expect(await update("DELETE FROM event_setup WHERE event_id = $1")).toBe("42501");
    expect(await update("UPDATE event_setup SET steps = 'short' WHERE event_id = $1")).toBe(
      "23514",
    );
    const other = await as({ organizerId: orgB, staffUserId: staffB }, () =>
      db.app.query("UPDATE event_setup SET current_step = 2 WHERE event_id = $1", [eventA]),
    );
    expect(other.rowCount).toBe(0);
  });

  it("removes the progress with its event", async () => {
    await clear();
    const { rows } = await db.owner.query<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, 'SETDEL', 'Gone', 'draft', now() + interval '1 day', now() + interval '2 days') RETURNING id`,
      [orgA],
    );
    const gone = rows[0]?.id ?? "";
    await seed(gone);
    await db.owner.query("DELETE FROM event WHERE id = $1", [gone]);
    const { rowCount } = await db.owner.query("SELECT 1 FROM event_setup WHERE event_id = $1", [
      gone,
    ]);
    expect(rowCount).toBe(0);
  });
});
