import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationFixture, type InvitationFixture } from "#test/support/invitations";
import { connectAsOwner, TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * T-813 part 1 (migrations 0172 to 0175, ADR-816). The reads a partial key could not serve: a foreign key's own check and
 * a read with no kind. With sequential scans priced out, each must reach its index whatever the size of this small
 * database; the sizes and buffers are in docs/PERFORMANCE_AUDIT.md. The claim's new read keeps the order and the limit it
 * had, and locks rows as its loop fetches them, not its whole page.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("T-813 indexes (database)", () => {
  let f: InvitationFixture;
  beforeAll(async () => {
    f = await invitationFixture();
    await f.switchOn();
  });
  afterAll(async () => {
    await f.close();
  });

  const planOf = async (sql: string, values: unknown[]): Promise<string> => {
    await f.owner("SET enable_seqscan = off");
    await f.owner("SET enable_bitmapscan = off");
    try {
      const rows = await f.owner(`EXPLAIN (COSTS OFF) ${sql}`, values);
      return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
    } finally {
      await f.owner("RESET enable_seqscan");
      await f.owner("RESET enable_bitmapscan");
    }
  };

  it.each([
    [
      "a reversal with no kind",
      "SELECT 1 FROM ledger_entry x WHERE x.reverses = $1::bigint",
      "ledger_entry_reverses_idx",
    ],
    [
      "a completion with no kind",
      "SELECT 1 FROM ledger_entry x WHERE x.completion_id = $1::bigint",
      "ledger_entry_completion_idx",
    ],
    [
      "an XP row by its ledger entry",
      "SELECT 1 FROM xp_entry x WHERE x.ledger_entry_id = $1::bigint",
      "xp_entry_ledger_idx",
    ],
  ])("reaches %s by its index, as the foreign key's check does", async (_name, sql, index) => {
    expect(await planOf(sql, [1])).toContain(index);
  });

  it("checks a deleted quest's ledger rows through the event index, on a key named by quest and event", async () => {
    const keys = await f.owner(
      `SELECT c.conname, c.confdeltype, c.confupdtype, c.condeferrable, c.convalidated,
              ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k (n, i)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols
       FROM pg_constraint c
       WHERE c.contype = 'f' AND c.conrelid = 'ledger_entry'::regclass AND c.confrelid = 'quest'::regclass`,
    );
    expect(keys).toEqual([
      {
        conname: "ledger_entry_quest_id_event_id_fkey",
        confdeltype: "r",
        confupdtype: "a",
        condeferrable: false,
        convalidated: true,
        cols: ["quest_id", "event_id"],
      },
    ]);
    const plan = await planOf(
      "SELECT 1 FROM ONLY ledger_entry x WHERE $1::uuid = x.quest_id AND $2::uuid = x.event_id FOR KEY SHARE OF x",
      [randomUUID(), randomUUID()],
    );
    expect(plan).toContain("ledger_entry_event_idx");
  });

  it("refuses a ledger row whose event is not its quest's event (23503)", async () => {
    const [home, other] = [
      await f.newEvent({ phase: "live" }),
      await f.newEvent({ phase: "live" }),
    ];
    const player = await f.newPlayer();
    const here = await f.join(home, player);
    const there = await f.join(other, player);
    const [quest] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, visible, type_config)
       SELECT $1, id, 'scan_qr', 'Elsewhere', 10, true, '{}' FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [other],
    );
    const [done] = await f.owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       SELECT organizer_id, id, $2, $3, 1, 'qr', gen_random_uuid()::text FROM event WHERE id = $1 RETURNING id`,
      [other, there, quest?.id],
    );
    const refused = await f
      .owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                                   quest_id, actor)
         SELECT organizer_id, id, $2, 'quest', 10, 10, $3, $4, 'player' FROM event WHERE id = $1`,
        [home, here, done?.id, quest?.id],
      )
      .then(
        () => "none",
        (error: { code?: string; constraint?: string }) => `${error.code}:${error.constraint}`,
      );
    expect(refused).toBe("23503:ledger_entry_quest_id_event_id_fkey");
  });

  it("reads a player's export rows from audit_log by index", async () => {
    const plan = await planOf(
      `SELECT a.action FROM audit_log a
       WHERE a.target_type = 'player' AND a.target_id = $1
         AND (a.action IN ('player.signup', 'player.contact_change', 'player.qr_reset')
              OR (a.action = 'player.data_export' AND a.after ->> 'source' = 'player'))`,
      [randomUUID()],
    );
    expect(plan).toContain("audit_log_player_export_idx");
  });

  it("claims the oldest campaign first and each campaign's lowest rows first", async () => {
    const { campaign, event } = await f.launch(50);
    const rows = await f.owner(
      "SELECT id FROM invitation_recipient WHERE campaign_id = $1 AND state = 'queued' ORDER BY id",
      [campaign],
    );
    const queued = rows.map((row) => String(row["id"]));
    expect(queued).toHaveLength(50);

    // A second running campaign, started later, holding the lowest rows: age decides before the row's own id.
    const later = randomUUID();
    await f.owner(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       SELECT organizer_id, $2, name_en, status, starts_at, ends_at FROM event WHERE id = $1`,
      [event, `T813${later.slice(0, 4)}`],
    );
    await f.owner(
      `INSERT INTO invitation_campaign (id, organizer_id, event_id, request_id, fingerprint, size, state, channels, cap,
                                        send_at, name_en, started_at, planned)
       SELECT $2, c.organizer_id, e.id, gen_random_uuid(), 'later', c.size, c.state, c.channels, c.cap, c.send_at,
              c.name_en, c.started_at + interval '1 minute', 25
       FROM invitation_campaign c JOIN event e ON e.join_code = $3 WHERE c.id = $1`,
      [campaign, later, `T813${later.slice(0, 4)}`],
    );
    await f.owner(
      "UPDATE invitation_recipient SET campaign_id = $1 WHERE id = ANY ($2::bigint[])",
      [later, queued.slice(0, 25)],
    );

    const claimed = await f.claimAt(5);
    expect(claimed.map((row) => String(row.recipient_id))).toEqual(queued.slice(25, 30));
  });

  /** Two running campaigns of 200 queued rows each: the reviewer's shape, where the old read locked all 400. */
  const twoCampaigns = async (): Promise<string[]> => {
    const { campaign, event } = await f.launch(400);
    const rows = await f.owner(
      "SELECT id FROM invitation_recipient WHERE campaign_id = $1 AND state = 'queued' ORDER BY id",
      [campaign],
    );
    const queued = rows.map((row) => String(row["id"]));
    const later = randomUUID();
    const code = `T813${later.slice(0, 4)}`;
    await f.owner(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       SELECT organizer_id, $2, name_en, status, starts_at, ends_at FROM event WHERE id = $1`,
      [event, code],
    );
    await f.owner(
      `INSERT INTO invitation_campaign (id, organizer_id, event_id, request_id, fingerprint, size, state, channels, cap,
                                        send_at, name_en, started_at, planned)
       SELECT $2, c.organizer_id, e.id, gen_random_uuid(), 'later', c.size, c.state, c.channels, c.cap, c.send_at,
              c.name_en, c.started_at + interval '1 minute', 200
       FROM invitation_campaign c JOIN event e ON e.join_code = $3 WHERE c.id = $1`,
      [campaign, later, code],
    );
    await f.owner(
      "UPDATE invitation_recipient SET campaign_id = $1 WHERE id = ANY ($2::bigint[])",
      [later, queued.slice(200)],
    );
    return queued;
  };

  it("locks only the rows its loop fetched while a claim of 5 is open", async () => {
    await twoCampaigns();
    const other = await connectAsOwner(f.db);
    await f.owner("BEGIN");
    try {
      const claimed = await f.claimAt(5);
      expect(claimed).toHaveLength(5);
      await other.query("BEGIN");
      const visible = await other.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM invitation_recipient WHERE state = 'queued'",
      );
      const free = await other.query<{ n: number }>(
        `SELECT count(*)::int AS n
         FROM (SELECT id FROM invitation_recipient WHERE state = 'queued' FOR UPDATE SKIP LOCKED) s`,
      );
      await other.query("ROLLBACK");
      // The 5 claimed and the rest of the loop's first fetch of 10, never the page of 200 or the 400 the page spans.
      expect(visible.rows[0]?.n).toBe(400);
      expect((visible.rows[0]?.n ?? 0) - (free.rows[0]?.n ?? 0)).toBeLessThanOrEqual(10);
    } finally {
      await f.owner("ROLLBACK");
      await other.end();
    }
  });

  it("skips a page row another session holds, and does not wait for it", async () => {
    const queued = await twoCampaigns();
    const other = await connectAsOwner(f.db);
    try {
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM invitation_recipient WHERE id = $1 FOR UPDATE", [queued[0]]);
      await f.owner("SET lock_timeout = '1s'");
      const claimed = await f.claimAt(5);
      expect(claimed.map((row) => String(row.recipient_id))).toEqual(queued.slice(1, 6));
    } finally {
      await f.owner("RESET lock_timeout");
      await other.query("ROLLBACK");
      await other.end();
    }
  });
});
