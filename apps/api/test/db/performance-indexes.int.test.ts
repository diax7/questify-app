import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationFixture, type InvitationFixture } from "#test/support/invitations";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * T-813 part 1 (migration 0172, ADR-816). The reads a partial key could not serve: a foreign key's own check and a read
 * with no kind. With sequential scans priced out, each must reach its index whatever the size of this small database; the
 * sizes and buffers are in docs/PERFORMANCE_AUDIT.md. The claim's new read keeps the order and the limit it had.
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
});
