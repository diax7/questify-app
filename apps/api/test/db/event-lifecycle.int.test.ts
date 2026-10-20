import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * Events in the database (T-102, migration 0009): the API's role never writes a status, times become history as the
 * event happens (judged on the status at now(), so the tick's lag is no gap), only drafts are deleted, the owner ends a
 * live event early, and the tick moves events by time.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event lifecycle (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let owner: string;
  let editor: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    owner = await addMember(db.owner, ids.orgA, "owner");
    editor = await addMember(db.owner, ids.orgA, "editor");
  });
  afterAll(async () => {
    await db.close();
  });

  const as = async <T extends Record<string, unknown>>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const seat = (staffUserId: string): RequestContext => ({ organizerId: ids.orgA, staffUserId });

  /** An event of organizer A in a given state, made with the owner connection (as activation would). */
  const eventIn = async (
    status: "draft" | "scheduled" | "live" | "ended",
    times: { starts: string; ends: string },
  ): Promise<string> => {
    counter += 1;
    const { rows } = await db.owner.query<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Lifecycle', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [ids.orgA, `LIFE${counter}`, status, times.starts, times.ends],
    );
    return rows[0]?.id ?? "";
  };
  const update = (who: string, id: string, set: string, values: unknown[] = []) =>
    as(seat(who), `UPDATE event SET ${set} WHERE id = $1`, [id, ...values]);
  const read = async (id: string) =>
    (
      await db.owner.query<{ status: string; ends_at: Date }>(
        "SELECT status, ends_at FROM event WHERE id = $1",
        [id],
      )
    ).rows[0];

  const endEarly = (who: string, id: string) =>
    as(seat(who), "SELECT end_event_early($1, NULL)", [id]);

  describe("what the API's role may write", () => {
    it("never writes a status, an organizer or a join code", async () => {
      const id = await eventIn("draft", { starts: "1 day", ends: "2 days" });
      for (const set of [
        "status = 'live'",
        "organizer_id = organizer_id",
        "join_code = 'HACKED1'",
      ]) {
        await expect(update(owner, id, set)).rejects.toThrow(/permission denied/);
      }
    });

    it("creates every event as a draft, whatever it asks for", async () => {
      await expect(
        as(
          seat(owner),
          "INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'LIVE01', 'x', 'live')",
          [ids.orgA],
        ),
      ).rejects.toThrow(/permission denied/);
      const [made] = await as<{ status: string }>(
        seat(owner),
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'DRAFT1', 'x') RETURNING status",
        [ids.orgA],
      );
      expect(made).toEqual({ status: "draft" });
    });

    it("refuses an unknown time zone and the public list on a private event", async () => {
      await expect(
        as(
          seat(owner),
          "INSERT INTO event (organizer_id, join_code, name_en, timezone) VALUES ($1, 'ZONE01', 'x', 'Mars/Base')",
          [ids.orgA],
        ),
      ).rejects.toThrow(/unknown time zone/);
      await expect(
        as(
          seat(owner),
          `INSERT INTO event (organizer_id, join_code, name_en, access, join_methods)
           VALUES ($1, 'PRIV01', 'x', 'private', ARRAY['code', 'public_list'])`,
          [ids.orgA],
        ),
      ).rejects.toThrow(/event_public_list_needs_public/);
    });
  });

  describe("times become history", () => {
    it("lets a draft change anything", async () => {
      const id = await eventIn("draft", { starts: "-2 days", ends: "-1 day" });
      await update(
        owner,
        id,
        "starts_at = now() + interval '5 days', ends_at = now() + interval '6 days'",
      );
    });

    it("keeps a scheduled event in the future", async () => {
      const id = await eventIn("scheduled", { starts: "1 day", ends: "2 days" });
      await update(editor, id, "starts_at = now() + interval '3 hours'");
      await expect(update(editor, id, "starts_at = now() - interval '1 hour'")).rejects.toThrow(
        /must start in the future/,
      );
    });

    it("never lets an activated event lose its times, whoever writes", async () => {
      const scheduled = await eventIn("scheduled", { starts: "1 day", ends: "2 days" });
      await expect(update(editor, scheduled, "starts_at = NULL")).rejects.toThrow(
        /event_times_once_active/,
      );
      await expect(update(editor, scheduled, "ends_at = NULL")).rejects.toThrow(
        /event_times_once_active/,
      );
      await expect(
        db.owner.query("UPDATE event SET ends_at = NULL WHERE id = $1", [scheduled]),
      ).rejects.toThrow(/event_times_once_active/);
    });

    it("treats a scheduled event whose start has passed as live, before the tick moves it", async () => {
      const id = await eventIn("scheduled", { starts: "-1 minute", ends: "1 day" });
      expect((await read(id))?.status).toBe("scheduled");
      await expect(update(editor, id, "starts_at = now() + interval '1 day'")).rejects.toThrow(
        /keeps its start/,
      );
    });

    it("lets a live event end later, never earlier, and locks its start, zone and day start", async () => {
      const id = await eventIn("live", { starts: "-1 hour", ends: "2 hours" });
      await update(editor, id, "ends_at = ends_at + interval '1 hour'");
      for (const set of [
        "ends_at = now() + interval '1 minute'",
        "ends_at = NULL",
        "starts_at = starts_at - interval '1 hour'",
        "timezone = 'Asia/Dubai'",
        "day_start_hour = 6",
      ]) {
        await expect(update(editor, id, set), set).rejects.toThrow(/live event keeps/);
      }
      expect((await as(seat(editor), "SELECT 1 FROM event WHERE id = $1", [id])).length).toBe(1);
    });

    it("locks every time of an ended event, including one past its end that the tick has not reached", async () => {
      const ended = await eventIn("ended", { starts: "-2 days", ends: "-1 day" });
      const pastEnd = await eventIn("live", { starts: "-2 hours", ends: "-1 minute" });
      for (const id of [ended, pastEnd]) {
        await expect(update(owner, id, "ends_at = now() + interval '1 day'")).rejects.toThrow(
          /ended event keeps its times/,
        );
      }
      await update(owner, ended, "name_en = 'Renamed after the fact'");
    });

    it("leaves the owner connection free (activation and support)", async () => {
      const id = await eventIn("live", { starts: "-1 hour", ends: "2 hours" });
      await db.owner.query(
        "UPDATE event SET ends_at = now() + interval '10 minutes' WHERE id = $1",
        [id],
      );
    });
  });

  describe("deleting", () => {
    it("deletes a draft, and nothing else, even with a raw delete", async () => {
      const draft = await eventIn("draft", { starts: "1 day", ends: "2 days" });
      const scheduled = await eventIn("scheduled", { starts: "1 day", ends: "2 days" });
      const live = await eventIn("live", { starts: "-1 hour", ends: "1 hour" });
      for (const id of [scheduled, live]) {
        await as(seat(owner), "DELETE FROM event WHERE id = $1", [id]);
      }
      await as(seat(owner), "DELETE FROM event WHERE id = $1", [draft]);
      const left = await db.owner.query<{ id: string }>("SELECT id FROM event WHERE id = ANY($1)", [
        [draft, scheduled, live],
      ]);
      expect(left.rows.map((row) => row.id).toSorted()).toEqual([scheduled, live].toSorted());
    });
  });

  describe("a deleted draft and editor limits", () => {
    it("leaves the limits that named it, but never empties one", async () => {
      const kept = await eventIn("draft", { starts: "1 day", ends: "2 days" });
      const gone = await eventIn("draft", { starts: "1 day", ends: "2 days" });
      const wide = await addMember(db.owner, ids.orgA, "editor", [kept, gone]);
      const narrow = await addMember(db.owner, ids.orgA, "editor", [gone]);
      await as(seat(owner), "DELETE FROM event WHERE id = $1", [gone]);
      const scopes = await db.owner.query<{ staff_user_id: string; event_scope: string[] }>(
        "SELECT staff_user_id, event_scope FROM organizer_member WHERE staff_user_id = ANY($1)",
        [[wide, narrow]],
      );
      const byId = Object.fromEntries(
        scopes.rows.map((row) => [row.staff_user_id, row.event_scope]),
      );
      expect(byId[wide]).toEqual([kept]);
      expect(byId[narrow]).toEqual([gone]);
    });
  });

  describe("ending early", () => {
    it("lets the owner end a live event now, audited", async () => {
      const id = await eventIn("live", { starts: "-1 hour", ends: "3 hours" });
      await endEarly(owner, id);
      const after = await read(id);
      expect(after?.status).toBe("ended");
      expect(after?.ends_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      const audit = await db.owner.query(
        "SELECT actor_id FROM audit_log WHERE event_id = $1 AND action = 'event.end'",
        [id],
      );
      expect(audit.rows).toEqual([{ actor_id: owner }]);
    });

    it("counts an event as live from its start, before the tick has moved it", async () => {
      const id = await eventIn("scheduled", { starts: "-1 minute", ends: "3 hours" });
      await endEarly(owner, id);
      expect((await read(id))?.status).toBe("ended");
    });

    it("refuses an editor, another organizer's owner, and an event that is not live", async () => {
      const live = await eventIn("live", { starts: "-1 hour", ends: "3 hours" });
      await expect(endEarly(editor, live)).rejects.toThrow(/only the owner/);
      const ownerB = await addMember(db.owner, ids.orgB, "editor");
      await expect(
        as({ organizerId: ids.orgB, staffUserId: ownerB }, "SELECT end_event_early($1, NULL)", [
          live,
        ]),
      ).rejects.toThrow(/only the owner/);
      const scheduled = await eventIn("scheduled", { starts: "1 day", ends: "2 days" });
      await expect(endEarly(owner, scheduled)).rejects.toThrow(/only a live event/);
    });
  });

  describe("the tick", () => {
    it("starts and ends events whose time has come, in one call, with an entry for each move", async () => {
      const toStart = await eventIn("scheduled", { starts: "-1 minute", ends: "1 day" });
      const toEnd = await eventIn("live", { starts: "-1 day", ends: "-1 minute" });
      const both = await eventIn("scheduled", { starts: "-2 days", ends: "-1 day" });
      const notYet = await eventIn("scheduled", { starts: "1 day", ends: "2 days" });
      const draft = await eventIn("draft", { starts: "-2 days", ends: "-1 day" });
      const [moved] = await as<{ moved: number }>({}, "SELECT advance_event_lifecycle() AS moved");
      expect(moved?.moved).toBeGreaterThanOrEqual(4);
      expect((await read(toStart))?.status).toBe("live");
      expect((await read(toEnd))?.status).toBe("ended");
      expect((await read(both))?.status).toBe("ended");
      expect((await read(notYet))?.status).toBe("scheduled");
      expect((await read(draft))?.status).toBe("draft");
      const audit = await db.owner.query<{ after: { status: string } }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.lifecycle' ORDER BY id",
        [both],
      );
      expect(audit.rows.map((row) => row.after.status)).toEqual(["live", "ended"]);
      await as({}, "SELECT advance_event_lifecycle()");
      const statuses = await db.owner.query<{ id: string; status: string }>(
        "SELECT id, status FROM event WHERE id = ANY($1)",
        [[toStart, toEnd, both, notYet, draft]],
      );
      const byId = Object.fromEntries(statuses.rows.map((row) => [row.id, row.status]));
      expect([byId[toStart], byId[toEnd], byId[both], byId[notYet], byId[draft]]).toEqual([
        "live",
        "ended",
        "ended",
        "scheduled",
        "draft",
      ]);
    });
  });

  describe("the status at now()", () => {
    it.each([
      ["draft", "-1 day", "-1 hour", "draft"],
      ["scheduled", "1 day", "2 days", "scheduled"],
      ["scheduled", "-1 minute", "1 day", "live"],
      ["scheduled", "-2 days", "-1 day", "ended"],
      ["live", "-1 hour", "1 hour", "live"],
      ["live", "-2 hours", "-1 minute", "ended"],
      ["ended", "-2 days", "-1 day", "ended"],
      ["archived", "-2 days", "-1 day", "archived"],
    ])("reads %s from %s to %s as %s", async (status, starts, ends, expected) => {
      const [row] = await as<{ now: string }>(
        {},
        "SELECT event_status_now($1, now() + $2::interval, now() + $3::interval) AS now",
        [status, starts, ends],
      );
      expect(row?.now).toBe(expected);
    });
  });
});
