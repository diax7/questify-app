import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { createStaff } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The cross-tenant suite at the database (T-012, NFR-016): with the API's own role, organizer A (or staff member A,
 * or player A) can read, change, delete or forge none of B's rows. Every table must be classified below; a new
 * table fails the first test until someone decides whose it is and proves it here.
 */

type Fixtures = Readonly<{
  orgA: string;
  orgB: string;
  eventA: string;
  eventB: string;
  publicEventB: string;
  playerA: string;
  playerB: string;
  staffA: string;
  staffB: string;
  /** The General category of organizer B's private event. */
  categoryB: string;
}>;

type Seat = "organizer" | "staff" | "player";

type Probe = Readonly<{
  /** Who asks: a member of organizer A, staff member A on their own, or player A. */
  seat: Seat;
  /** The column that says whose a row is, from this seat's point of view. */
  column: string;
  mine: (f: Fixtures) => string;
  theirs: (f: Fixtures) => string;
  /** B's rows that A may read by design (public pages), as a filter on top of the column; none when absent. */
  publicRows?: (f: Fixtures) => Readonly<{ sql: string; values: unknown[] }>;
  /** Why A cannot read even its own rows by this column, when that is so. */
  ownRowsHidden?: string;
  /** An insert that claims B's ownership, and the wall expected to refuse it. */
  forge: (f: Fixtures) => Readonly<{ sql: string; values: unknown[] }>;
  forgeRefusedBy?: RegExp;
}>;

type Owned = Readonly<{
  probes: readonly Probe[];
  /**
   * Rows any caller may delete by design (a retention sweep), as a filter on columns prefixed by `row` ("" in a
   * query, "OLD." in a trigger); a bare delete must stop exactly there.
   */
  sweep?: (row: string) => string;
}>;

/** Each side's digital reward with one code, made with known ids: the organizer role cannot read `organizer_id` here. */
const CODE_REWARD_A = "c0de0000-0000-4000-8000-00000000000a";
const CODE_REWARD_B = "c0de0000-0000-4000-8000-00000000000b";

/** Each side's operator assignment, made with known ids for the quest-limit probe. */
const ASSIGNMENT_A = "0be7a000-0000-4000-8000-00000000000a";
const ASSIGNMENT_B = "0be7a000-0000-4000-8000-00000000000b";

const POLICY = /row-level security/;
const SIGNUP_A = "new.owner@najd.test";
const SIGNUP_B = "new.owner@tabuk.test";
/** Each seeded rehearsal has its own code (codes are unique across events). */
let rehearsalSeeds = 0;
const hash = () => `\\x${randomBytes(32).toString("hex")}`;
/** A call's SQLSTATE, or "none" when it succeeds. */
const refusal = async (work: Promise<unknown>) =>
  work.then(
    () => "none",
    (error: { code?: string }) => error.code,
  );

const OWNED: Readonly<Record<string, Owned>> = {
  organizer: {
    probes: [
      {
        seat: "organizer",
        column: "id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        publicRows: () => ({ sql: "true", values: [] }),
        forge: () => ({
          sql: "INSERT INTO organizer (name, slug) VALUES ('Forged', 'forged-org')",
          values: [],
        }),
      },
    ],
  },
  organizer_member: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
          values: [f.orgB, f.staffA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  event: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        publicRows: (f) => ({ sql: "id = $2", values: [f.publicEventB] }),
        forge: (f) => ({
          sql: "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'FORGE1', 'Forged')",
          values: [f.orgB],
        }),
      },
    ],
  },
  category: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO category (event_id, name_en) VALUES ($1, 'Stolen')",
          values: [f.eventB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden: "players read quests through their own API (T-105, T-114), not these tables",
        forge: (f) => ({
          sql: "INSERT INTO category (event_id, name_en) VALUES ($1, 'Mine now')",
          values: [f.eventA],
        }),
      },
    ],
  },
  quest: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Stolen', 1)",
          values: [f.eventB, f.categoryB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden: "players read quests through their own API (T-105, T-114), not these tables",
        forge: (f) => ({
          sql: "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, gen_random_uuid(), 'scan_qr', 'Mine now', 1)",
          values: [f.eventA],
        }),
      },
    ],
  },
  passport_step: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO passport_step (event_id, quest_id, name_en) VALUES ($1, gen_random_uuid(), 'Stolen')",
          values: [f.eventB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden:
          "players read a passport's steps through member_passport (T-304b), not this table",
        forge: (f) => ({
          sql: "INSERT INTO passport_step (event_id, quest_id, name_en) VALUES ($1, gen_random_uuid(), 'Mine now')",
          values: [f.eventA],
        }),
      },
    ],
  },
  reward: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Stolen', 1, 1)",
          values: [f.eventB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden:
          "players read the shop through event_shop and shop_rewards (T-201), not this table",
        forge: (f) => ({
          sql: "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Mine now', 1, 1)",
          values: [f.eventA],
        }),
      },
    ],
  },
  rank_prize: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 50, 50, 'experience', 'Stolen')",
          values: [f.eventB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden:
          "players read prizes through event_results and the rules definers (T-214), not this table",
        forge: (f) => ({
          sql: "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 50, 50, 'experience', 'Mine now')",
          values: [f.eventA],
        }),
      },
    ],
  },
  quest_item: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Stolen', 1)",
          values: [f.eventB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden:
          "players learn a quest item through own_quest_item, own_bonus and their redemptions (T-304d), not this table",
        forge: (f) => ({
          sql: "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Mine now', 1)",
          values: [f.eventA],
        }),
      },
    ],
  },
  redemption: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until) SELECT organizer_id, event_id, enrollment_id, reward_id, 1, 'forged', now() FROM redemption WHERE event_id = $1",
          values: [f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden:
          "players read their reservations through my_redemptions (T-202), not this table",
        forge: (f) => ({
          sql: "INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until) VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 1, 'forged', now())",
          values: [f.orgA, f.eventA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  reward_code: {
    probes: [
      {
        seat: "organizer",
        column: "reward_id",
        mine: () => CODE_REWARD_A,
        theirs: () => CODE_REWARD_B,
        forge: () => ({
          sql: "INSERT INTO reward_code (reward_id, code_cipher, code_hash) VALUES ($1, $2, $3)",
          values: [CODE_REWARD_B, Buffer.alloc(40), Buffer.alloc(32)],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "reward_id",
        mine: () => CODE_REWARD_A,
        theirs: () => CODE_REWARD_B,
        ownRowsHidden:
          "players see their own code through reserve_reward and my_redemptions (T-203), not this table",
        forge: () => ({
          sql: "INSERT INTO reward_code (reward_id, code_cipher, code_hash) VALUES ($1, $2, $3)",
          values: [CODE_REWARD_A, Buffer.alloc(40), Buffer.alloc(32)],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  staff_assignment: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          values: [f.orgB, f.eventB, f.playerA],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden:
          "player A staffs no event; an operator reading their own row is in operators.int.test.ts",
        forge: (f) => ({
          sql: "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          values: [f.orgB, f.eventB, f.playerA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  staff_assignment_quest: {
    probes: [
      {
        seat: "organizer",
        column: "event_id",
        mine: (f) => f.eventA,
        theirs: (f) => f.eventB,
        forge: (f) => ({
          sql: "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) SELECT $1, event_id, id FROM quest WHERE event_id = $2",
          values: [ASSIGNMENT_B, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  operator_invite: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO operator_invite (organizer_id, event_id, kind, label, abilities, created_by, expires_at) VALUES ($1, $2, 'personal', 'Forged', '{scan_quests}', $3, now() + interval '1 day')",
          values: [f.orgB, f.eventB, f.staffA],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden:
          "players never read invites: they preview and claim through definers (T-204)",
        forge: (f) => ({
          sql: "INSERT INTO operator_invite (organizer_id, event_id, kind, label, abilities, created_by, expires_at) VALUES ($1, $2, 'personal', 'Forged', '{scan_quests}', $3, now() + interval '1 day')",
          values: [f.orgA, f.eventA, f.staffA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  quest_completion: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key) SELECT organizer_id, event_id, id, gen_random_uuid(), 1, 'qr', 'forged' FROM enrollment WHERE event_id = $1",
          values: [f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key) SELECT organizer_id, event_id, id, gen_random_uuid(), 1, 'qr', 'forged' FROM enrollment WHERE event_id = $1",
          values: [f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  bulk_award: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO bulk_award (organizer_id, event_id, staff_user_id, amount, reason, requested, awarded, skipped, idempotency_key) VALUES ($1, $2, gen_random_uuid(), 5, 'forged', 0, 0, 0, 'forged')",
          values: [f.orgB, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden: "players never read award reasons (T-207); the record names only the kind",
        forge: (f) => ({
          sql: "INSERT INTO bulk_award (organizer_id, event_id, staff_user_id, amount, reason, requested, awarded, skipped, idempotency_key) VALUES ($1, $2, gen_random_uuid(), 5, 'forged', 0, 0, 0, 'forged')",
          values: [f.orgA, f.eventA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  ledger_note: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) SELECT id, $1, $2, 'forged' FROM ledger_entry LIMIT 1",
          values: [f.orgB, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden: "players never read award reasons (T-207); the record names only the kind",
        forge: (f) => ({
          sql: "INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) SELECT id, $1, $2, 'forged' FROM ledger_entry LIMIT 1",
          values: [f.orgA, f.eventA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  ledger_entry: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor) VALUES ($1, $2, gen_random_uuid(), 'quest', 1000, 1000, 'player')",
          values: [f.orgB, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor) VALUES ($1, $2, gen_random_uuid(), 'quest', 1000, 1000, 'player')",
          values: [f.orgB, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  enrollment: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          values: [f.orgB, f.publicEventB, f.playerA],
        }),
      },
      {
        seat: "player",
        column: "player_id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        forge: (f) => ({
          sql: "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          values: [f.orgA, f.eventA, f.playerB],
        }),
      },
    ],
  },
  event_exclusion: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO event_exclusion (organizer_id, event_id, kind, value, created_by) VALUES ($1, $2, 'email_domain', 'forged.sa', $3)",
          values: [f.orgB, f.eventB, f.staffA],
        }),
        // Written only by add_exclusion and remove_exclusion, which check the owner (T-208).
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  event_activation_request: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO event_activation_request (event_id, organizer_id, state) VALUES ($1, $2, 'pending')",
          values: [f.publicEventB, f.orgB],
        }),
        // Written only by request_event_activation and the console's definers (T-210).
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  event_limit_alert: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO event_limit_alert (event_id, organizer_id, level, players) VALUES ($1, $2, 100, 1)",
          values: [f.publicEventB, f.orgB],
        }),
        // Written only by the limit trigger and set_event_player_limit (T-210).
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  event_rehearsal: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'ZZZZ-ZZZZ')",
          values: [f.publicEventB, f.orgB],
        }),
        // Written only by open_rehearsal, rotate_rehearsal_code and the wipe (T-211).
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  event_join_field: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        // The organizer comes from the event (a trigger), so naming B's event is the claim.
        forge: (f) => ({
          sql: "INSERT INTO event_join_field (event_id, kind, label_en, position) VALUES ($1, 'custom', 'Forged', 4)",
          values: [f.eventB],
        }),
      },
    ],
  },
  event_guest: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO event_guest (event_id, kind, value) VALUES ($1, 'email', 'forged@tabuk.test')",
          values: [f.eventB],
        }),
      },
    ],
  },
  join_answer: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) VALUES (gen_random_uuid(), gen_random_uuid(), $1, $2, 'Forged')",
          values: [f.orgB, f.eventB],
        }),
        // Written only by the join definers (T-212): the API role holds no write right.
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) VALUES (gen_random_uuid(), gen_random_uuid(), $1, $2, 'Forged')",
          values: [f.orgB, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  event_entitlement: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        publicRows: (f) => ({ sql: "event_id = $2", values: [f.publicEventB] }),
        forge: (f) => ({
          sql: "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'teleporter')",
          values: [f.publicEventB, f.orgB],
        }),
      },
    ],
  },
  audit_log: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type) VALUES ('staff', $1, $2, 'event.forged', 'event')",
          values: [f.staffA, f.orgB],
        }),
      },
    ],
  },
  staff_user: {
    probes: [
      {
        seat: "staff",
        column: "id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        forge: () => ({
          sql: "INSERT INTO staff_user (email, password_hash) VALUES ('forged@x.test', 'x')",
          values: [],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  staff_session: {
    sweep: (row) => `coalesce(${row}revoked_at, ${row}last_seen_at) < now() - interval '30 days'`,
    probes: [
      {
        seat: "staff",
        column: "staff_user_id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        forge: (f) => ({
          sql: "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)",
          values: [f.staffB, hash()],
        }),
      },
    ],
  },
  staff_login_challenge: {
    sweep: (row) => `${row}created_at < now() - interval '1 day'`,
    probes: [
      {
        seat: "staff",
        column: "staff_user_id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        ownRowsHidden: "a challenge is read only by its own token, during sign-in",
        forge: (f) => ({
          sql: "INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')",
          values: [f.staffB, hash(), hash()],
        }),
      },
    ],
  },
  staff_password_reset: {
    sweep: (row) => `${row}created_at < now() - interval '1 day'`,
    probes: [
      {
        seat: "staff",
        column: "staff_user_id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        ownRowsHidden: "a reset link is read only by its own token, from the emailed link",
        forge: (f) => ({
          sql: "INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
          values: [f.staffB, hash()],
        }),
      },
    ],
  },
  organizer_acceptance: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by) VALUES ($1, 'organizer_terms', '9.9', $2)",
          values: [f.orgB, f.staffA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  organizer_invite: {
    sweep: (row) => `${row}expires_at < now() - interval '30 days'`,
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, 'forged@x.test', 'editor', $2, $3, now() + interval '7 days')",
          values: [f.orgB, hash(), f.staffA],
        }),
      },
    ],
  },
  staff_signup: {
    sweep: (row) => `${row}created_at < now() - interval '1 day'`,
    probes: [
      {
        seat: "staff",
        column: "email",
        mine: () => SIGNUP_A,
        theirs: () => SIGNUP_B,
        ownRowsHidden: "a pending sign-up is read only by its own token, during sign-up",
        forge: () => ({
          sql: "INSERT INTO staff_signup (token_hash, code_hash, email, organizer_name, accepted_terms, accepted_dpa, accepted_content, expires_at) VALUES ($1, $2, 'forged@x.test', 'Forged', '0.1', '0.1', '0.1', now() + interval '10 minutes')",
          values: [hash(), hash()],
        }),
      },
    ],
  },
  player: {
    probes: [
      {
        seat: "player",
        column: "id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        forge: () => ({ sql: "INSERT INTO player (username) VALUES ('forged_one')", values: [] }),
        // Since T-109 no one but the sign-up definer creates a player.
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "organizer",
        column: "id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        ownRowsHidden:
          "organizers read their players only through event_players, with the join card's columns (T-208)",
        forge: () => ({ sql: "INSERT INTO player (username) VALUES ('forged_two')", values: [] }),
        // Since T-109 no one but the sign-up definer creates a player.
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  player_contact: {
    probes: [
      {
        seat: "player",
        column: "player_id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        forge: (f) => ({
          sql: "INSERT INTO player_contact (player_id, email) VALUES ($1, 'forged@x.test')",
          values: [f.playerB],
        }),
        // Since T-108 the API's role writes no contact: create_player and confirm_contact_change do.
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "organizer",
        column: "player_id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        ownRowsHidden:
          "contact details are for the player and Questify admins only, even in your own events",
        forge: (f) => ({
          sql: "INSERT INTO player_contact (player_id, email) VALUES ($1, 'forged@x.test')",
          values: [f.playerA],
        }),
        // Since T-108 the API's role writes no contact: create_player and confirm_contact_change do.
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
};

/** Tables that belong to nobody in particular, with the reason; their write rules are tested where they live. */
const SHARED: Readonly<Record<string, string>> = {
  souvenir_rule:
    "no direct API rights; event-scoped owner/editor definers and cross-tenant forgery tests (souvenirs)",
  souvenir_target: "no direct API rights; same-event frozen targets only (souvenirs)",
  souvenir_receipt:
    "no direct API rights; system evaluator alone grants; own locker source never public (souvenirs)",
  souvenir_work:
    "no direct API rights; real-only generation-fenced system work, erasure tested (souvenirs)",
  souvenir_scan:
    "no direct API rights; bounded system backfill under activated event rules (souvenirs)",
  souvenir_command:
    "no direct API rights; organizer command replay bound to actor/event/body (souvenirs)",
  item: "global catalog, no direct API rights; narrow DTOs only (profile-items)",
  city: "platform-wide seeded list, no direct API rights; read through city_list (event-passport)",
  achievement:
    "platform-wide catalog, no direct API rights; read through the caller-bound own_achievements and the public profile's tiers (achievements)",
  achievement_earned:
    "no direct API rights; append-only, written only by questify_sync for the calling player, read as tiers by own_achievements and the public profile; no organizer read exists (achievements)",
  final_rank:
    "no direct API rights; append-only, written only by confirm_results inside the owner's event, read only through own_events for the calling player and the public passport after the reveal; no organizer read exists (final-rank, event-passport)",
  questify_campaign:
    "platform-wide catalog with no tenant, no direct API rights; written only by the admin-checked, audited console doors, read by the caller-bound own_questify_quests (questify-quests)",
  questify_quest:
    "platform-wide catalog with no tenant, no direct API rights; written only by the admin-checked, audited console doors, read by the caller-bound own_questify_quests (questify-quests)",
  questify_award:
    "no direct API rights; append-only, written only by questify_sync for the calling player from their own facts, read as `done` by own_questify_quests; no organizer read exists (questify-quests)",
  gem_entry:
    "no direct API rights; append-only, written only by questify_sync and gem_buy for the calling player, each row bound to the same player's source row; never shown to anyone else, no organizer read exists (gems)",
  interest:
    "platform-wide seeded catalog with no tenant and no direct API rights; read through interest_list (marketing)",
  player_preference:
    "no direct API rights; one row per player written and read only by set_preferences and own_preferences for the calling player, read by the promotional audience as ids only; no organizer or public read exists (marketing)",
  marketing_consent:
    "no direct API rights; append-only, written only by set_marketing for the calling player and marketing_opt_out for a signed link; read by the calling player's state and a platform admin's audited door; erased with the account (marketing)",
  marketing_state:
    "no direct API rights; written only by the consent log's trigger, read by own_marketing for the caller and by marketing_audience as ids of opted-in players; no organizer or public read exists (marketing)",
  gem_purchase:
    "no direct API rights; append-only, written only by gem_buy for the calling player; no organizer read exists (gem-shop)",
  invitation_campaign:
    "no direct API rights; written only by the owner's tenant- and scope-checked doors (invitation_request, invitation_cancel), the admin-checked console doors and the system-only sender; read by its event's team through invitation_list with rounded counts only (tested below, invitation-campaigns, invitations/routes)",
  invitation_recipient:
    "no direct API rights; who was invited is never shown to an organizer: written by the system-only fill, claim, ack and settle, the anonymous invitation_open by bearer link, deleted by erasure and the 90-day purge (invitation-sending)",
  invitation_channel_hold:
    "no direct API rights; one row per channel with a provider code, no tenant and no person; written by the system-only ack, read by the claim and the console's detail (invitation-sending)",
  notice_kind:
    "platform-wide catalog of push kinds with no tenant and no direct API rights; seeded by migrations, read only by the definers (push-store)",
  notice:
    "no direct API rights; written only by notice_create inside a producer's own door (one insert) and read by the system-only fan-out, claim and the caller-bound own_notifications for the calling player's center rows only (push-store, cross-tenant below)",
  announcement:
    "no direct API rights; event-scoped owner/editor doors use award_event_of; member_announcements is caller-bound, active members only, rehearsal-separated (announcements database and HTTP suites)",
  notification:
    "no direct API rights; the notification center: written only by the system-only fan-out, read and marked only by the caller-bound own_notifications, own_unread_notifications and mark_notifications_read for the calling player (tested below, push-store, push/routes)",
  push_device:
    "no direct API rights; one row per sign-in, written only by push_device_register and push_device_remove for the calling player's own live session (the bearer token's hash), read by the system-only claim; no organizer read exists (push-store, push/routes)",
  push_topic_mute:
    "no direct API rights; the calling player's own muted topics through own_push_topics and set_push_topics, read by the system-only fan-out and claim; no organizer read exists (push-store)",
  push_send:
    "no direct API rights; the push outbox, written and read only by the system-only fan-out, claim, ack and settle, which refuse every seat with an identity (push-sending)",
  rank_top_snapshot:
    "no direct API rights; one row per live event holding enrollment ids only (no name, no player id), written and read only by the system-only rank_push_diff and rank_push_events (rank-push)",
  organizer_alert_switch:
    "no direct API rights; one row per member and type, read and written only by the caller-bound own_alert_switches and set_own_alert_switches (a member of that organizer, their own row), read by the producers and the system-only claim (organizer-alerts, organizer-alerts/routes)",
  organizer_alert:
    "no direct API rights; the alert outbox, ids only: written by the producers' triggers and the system-only flag scan for the organizer's own members, read and moved only by the system-only claim, ack and settle (organizer-alerts)",
  gem_shop_item:
    "platform-wide catalog with no tenant, no direct API rights; seeded only, read through the caller-bound gem_shop (gem-shop)",
  level_item: "global reward map, no API writes; one item per configured level (profile-items)",
  player_item:
    "no direct API rights; own_locker/equip/seen caller-bound and forged access tested in profile-items",
  player_equipment:
    "no direct API rights; caller-bound equipment setters and public-safe read tested in profile-items",
  platform_setting: "platform-wide settings; only a Questify admin writes (test/settings)",
  translation: "platform-wide texts; only a Questify admin writes (test/translations)",
  auth_throttle: "keyed by a one-way tag, not by a person; no data to leak (test/auth)",
  schema_migration: "the migration record; the API role has no rights on it (outsider suite)",
  player_acceptance:
    "a player reads only their own rows (policy on app_player_id()); no write right at all, the definers record acceptances (test/db/player-legal)",
  player_contact_challenge:
    "no right for the API role at all; a contact change is reached only through definers bound to the calling player (test/db/contact-change)",
  player_login_challenge:
    "no right for the API role at all; a challenge is reached only through definers bound to its token (test/db/player-sign-in)",
  player_refresh:
    "no right for the API role at all; a refresh token is rotated only through a definer bound to it (test/db/player-sign-in)",
  username_history:
    "no right for the API role at all; written by a trigger on player and read by the console later (test/db/usernames)",
  username_word:
    "no right for the API role at all; read by the username check inside the definers (test/db/usernames)",
  ranking_repair:
    "no right for the API role at all; marks are set by definers and triggers and claimed by the repair tick (test/db/ranking)",
  manual_award_key:
    "no right for the API role at all; written and read only by the award and removal definers (test/db/awards)",
  flag: "no right for the API role at all; raised by a trigger on completions, read and closed only through the team's definers inside their events (test/db/flags)",
  event_result:
    "no right for the API role at all; written and read only through the owner's confirm and reveal definers and the results reads inside the caller's event (test/db/results)",
  result_place:
    "no right for the API role at all; written by confirm_results and reveal_results, read through results_places and event_results (test/db/results)",
  player_session:
    "no right for the API role at all; a token is looked up only through player_session_owner(hash) (test/db/completion-engine)",
  player_fingerprint:
    "no right for the API role at all; written by the sign-in and contact-change definers, read and cleared by erase_player (test/db/account-deletion)",
  erased_mark:
    "no right for the API role at all; holds no player id; written by erase_player, read inside the join, welcome and sign-in definers (test/db/account-deletion)",
  player_deletion_challenge:
    "no right for the API role at all; reached only through definers bound to its token or deletion token (test/db/account-deletion)",
  player_xp:
    "no right for the API role at all; Questify-wide, not an organizer's; written by the ledger's XP trigger, read only through own_level for the calling player (test/db/xp)",
  xp_board:
    "no right for the API role at all; Questify-wide, not an organizer's; a cache of xp_entry written only by xp_apply under the player's player_xp lock, read through questify_ranking and the admin's season doors (test/db/questify-ranking)",
  xp_entry:
    "no right for the API role at all; append-only, written by the ledger's XP trigger (test/db/xp)",
  level_reached:
    "no right for the API role at all; append-only, written by the ledger's XP trigger, read through own_level (test/db/xp)",
  xp_level:
    "platform-wide curve; no right for the API role, read inside the XP definers (test/db/xp)",
  level_title:
    "platform-wide titles; no right for the API role, read through own_level (test/db/xp)",
  quest_vote:
    "no right for the API role at all; written by vote_quest, read by the voter through member_vote and member_poll, as counts by the event's team through quest_vote_counts and by a player the poll's policy allows through poll_results (test/db/vote-quiz, test/db/live-polls)",
  survey_response:
    "no right for the API role at all; written by submit_survey, read by the event's team as totals and texts with names not shown through survey_summary; players read only whether they answered, through member_survey (test/db/challenge-survey-share)",
  category_bonus:
    "no right for the API role at all; written by pay_category_bonus inside the paying definers, read by the player through own_bonus, own_category_bonus and member_event_quests (test/db/category-rules)",
  category_reveal:
    "no right for the API role at all; written by reveal_category for the calling player and by record_completion on a staff manual award, read inside the player's definers through sees_category (test/db/categories-hidden)",
  quest_item_miss:
    "no right for the API role at all; written by give_item inside the paying definers, read by the player through own_quest_item, own_bonus and own_category_bonus and by the team through quest_items and quest_item_misses (test/db/quest-items)",
  completion_position:
    "no right and no policy for the API role at all; holds rounded distances, accuracy and the mocked mark (never a coordinate), written by keep_position inside record_completion, read by the event's team only as flag_detail's lines (test/db/location)",
  game_round:
    "no right and no policy for the API role at all; written by start_game_round and finish_game_round for the calling player, by the sweep and the leave trigger; read by its own player through game_round_for_replay and member_game (another player's round is no row, QC404), and by the event's team only as flag_detail's lines (test/db/games)",
  meet_pass:
    "no right and no policy for the API role at all; holds only a token's SHA-256 hash, written by issue_meet_pass for the calling player, read through meet_pass_state for its own player and by meet_player by hash (test/db/meet)",
  meeting:
    "no right and no policy for the API role at all; written by meet_player after both payments, read only inside the meet definers; no team read exists (test/db/meet)",
  passport_stamp:
    "no right for the API role at all; written by stamp_step for the calling player, read by the player through member_passport and member_event_quests and by the event's team as step ids through stamped_steps and submitters_of (test/db/passport)",
  quiz_attempt:
    "no right for the API role at all; written by quiz_start, quiz_next, quiz_answer and the sweep, read by the player through member_quiz (test/db/vote-quiz)",
  quiz_answer:
    "no right for the API role at all; written by quiz_next and quiz_answer, read by the player through member_quiz (test/db/vote-quiz)",
  submission:
    "no right for the API role at all; written by submit_quest and the review definers, read by the player through own_submissions and by the event's team through event_submissions and operator_submissions (test/db/submissions)",
  ticket:
    "no right and no policy for the API role at all; written by open_ticket for the calling player's own active enrollment, by the answer doors inside the caller's event (award_event_of, help_operator) and by the sweep, erasure and the rehearsal wipe; read by its sender through own_tickets, by the event's team through event_tickets and by an operator of the event through operator_ticket and operator_inbox (test/db/tickets, which also crosses organizers, events and players); T-312 adds open_platform_ticket (the caller's own, no event), staff_escalate_ticket inside the caller's event (award_event_of), and Questify's queue for an active platform admin only (app_admin_id re-read), exactly the rows with queue = 'questify' (test/db/tickets-center crosses organizers A and B and the admin who is also a member)",
  community_goal:
    "no right for the API role at all; written by save_community_goal and delete_community_goal inside the caller's event, by the settling definers in the system context and by the event switch's trigger; read by the event's team through community_goals and by its active members through live_state (test/db/community)",
  community_step:
    "no right for the API role at all; written with its goal by save_community_goal, read through community_goals and live_state (test/db/community)",
  community_reach:
    "no right for the API role at all; written by the settling definers in the system context, read through community_goals and live_state (test/db/community)",
  community_contributor:
    "no right for the API role at all; written by the settling definers in the system context, read only as the calling member's own `contributed` in live_state (test/db/community)",
  community_payout:
    "no right for the API role at all; written by the settling definers and pay_community_batch in the system context, read as counts by the event's team through community_goals and community_paying and as the calling member's own `mine` in live_state (test/db/community)",
  boost:
    "no right for the API role at all; written by save_boost, delete_boost and end_boost inside the caller's event (award_event_of) and deleted by the rehearsal wipe; read by the event's team through event_boosts and by its active members through boost_in_force in member_event_quests, live_state and the payers (test/db/flash-boosts)",
  nfc_tag:
    "no right for the API role at all; written by register_nfc_tag for an operator of the tag's event (nfc_writer), and by move_nfc_tag, revoke_nfc_tag and revoke_quest_nfc_tags inside the caller's event (award_event_of); read by tap_quest only for a member of the tag's event, by operator_nfc_tags for the calling operator's own writes and by quest_nfc_tags for the event's team (test/db/nfc-tags)",
  nfc_tap:
    "no right for the API role at all; written by tap_quest beside the calling player's own completion and removed with it; read as counts by the event's team through quest_nfc_tags and by raise_nfc_flag for the tapping member (test/db/nfc-tags)",
  device_request:
    "no right for the API role at all; belongs to no tenant until claimed: written by open_device_request and renew_device_request (a hash of the browser's own secret and code) and turned into a paired device by operator_claim_device and team_claim_device only for the caller's own event; read by device_session for its own secret and by preview_device for the caller's event (test/db/devices)",
  quest_first_bonus:
    "no right for the API role at all; written by set_quest_first_bonus inside the caller's event (award_event_of) and deleted with its quest or a draft event; read as counts by first_bonus_left (an active member of the event or its team in scope, nothing for anyone else), live_state and member_event_quests for the calling member, and own_first_bonus for the caller's own completion (test/db/first-bonus crosses organizers and players)",
  quest_bonus_slot:
    "no right for the API role at all; holds no personal data beyond an enrollment id the ledger already names; claimed only by pay_first_bonus inside the payers for the paying enrollment, freed by the rehearsal wipe, added and removed by set_quest_first_bonus inside the caller's event; read as counts by first_bonus_left and as the calling member's own place by member_event_quests and own_first_bonus, and by the team through member_ledger (award_event_of) (test/db/first-bonus)",
  event_streak:
    "no right for the API role at all; written by set_event_streak only for an owner of the event's organizer within their events (AN404 otherwise), read by event_streak_settings (award_event_of), own_event_streak for an active member and the ledger_streak trigger (test/security cross-tenant streak doors, test/db/event-streak)",
  event_streak_day:
    "no right for the API role at all; append-only; holds no personal data beyond an enrollment id the ledger already names; written only by the ledger_streak trigger for the paying enrollment; read as the calling member's own by own_event_streak and own_streak_bonus, and by the team through member_ledger (award_event_of) (test/db/event-streak)",
  questify_streak_day:
    "no right for the API role at all; append-only, no tenant: a player's own Questify days, written by the ledger_streak trigger for the paying enrollment's player; read only for the caller by own_daily_streak and questify_sync, never by an organizer (test/security cross-tenant streak doors, test/db/daily-streak)",
  questify_streak_milestone:
    "platform-wide data with no tenant and no direct API rights; append-only; seeded by migration, read through the caller-bound own_daily_streak and questify_sync (test/db/daily-streak)",
  questify_streak_reward:
    "no right for the API role at all; append-only, no tenant: written only by questify_sync for the calling player under their player_xp lock, read only for the caller (test/db/daily-streak)",
  kiosk_scan:
    "no right for the API role at all; holds no personal data (a completion id, a device id, tenant ids); written only by kiosk_complete_quest for app_device_id's own kiosk beside the completion it paid, read as a count by device_json in the caller's event or own pairings (test/db/kiosks)",
  paired_device:
    "no right for the API role at all; written by the claims inside the caller's event (device_operator, award_event_of), by revoke_device, revoke_devices and the removal triggers; read by device_session for its own secret, by the device definers only for app_device_id's own row, and by event_devices and operator_devices for the caller's event or own pairings (test/db/devices)",
  daily_cadence:
    "platform-wide schedule data with no tenant and no right for the API role; written only by the admin-checked, audited daily_cadence_set for tomorrow, rows whose day has come frozen for every role (test/db/daily-content)",
  daily_question:
    "platform-wide content with no tenant and no right for the API role; written by the admin-checked, audited console doors; a player sees a question's right option only after answering it (test/security/daily-players, test/db/daily-challenge)",
  daily_challenge:
    "platform-wide content with no tenant and no right for the API role; written by the admin-checked, audited console doors for future periods only (frozen once started for every role), read by the caller-bound own_daily and the player doors (test/db/daily-content)",
  daily_challenge_question:
    "platform-wide content with no tenant and no right for the API role; written with its challenge by daily_challenge_set, frozen with it (test/db/daily-content)",
  daily_word:
    "platform-wide content with no tenant and no right for the API role; written by the admin-checked console doors, never updated; the word reaches a player only once that player's game is over (test/security/daily-players, test/db/daily-word)",
  word_guess_list:
    "platform-wide word list with no tenant and no right for the API role; written by the admin-checked word_list_change and daily_word_set, read by the guess door's check and word_list_page (test/db/daily-content)",
  daily_play:
    "no right for the API role at all; append-only, no tenant: written only by the player doors for the calling player (no door takes a player id), read only for the caller by own_daily and as counts by the console (test/security/daily-players)",
  daily_answer:
    "no right for the API role at all; append-only, no tenant: the calling player's own answers, written and read only through the caller's play (test/security/daily-players, test/db/daily-challenge)",
  daily_guess:
    "no right for the API role at all; append-only, no tenant: the calling player's own guesses, written and read only through the caller's play (test/security/daily-players, test/db/daily-word)",
  daily_finish:
    "no right for the API role at all; append-only, no tenant: one per play of the calling player under their player_xp lock, kept on the tombstone; read for the caller and as counts by the console (test/db/daily-challenge)",
};

/** A seat holding ids that own no row anywhere, so any row a bare write reaches is someone else's. */
const emptyHanded = (seat: Seat): RequestContext =>
  seat === "organizer"
    ? { organizerId: randomUUID(), staffUserId: randomUUID() }
    : seat === "staff"
      ? { staffUserId: randomUUID() }
      : { playerId: randomUUID() };

/** Thrown to roll a probe back after reading its result. */
class Rollback extends Error {
  constructor(readonly rowCount: number) {
    super("rollback");
  }
}

/** Runs one statement in the seat's context, reports the rows it touched, and rolls it back. */
async function touched(
  db: TestDatabase,
  context: RequestContext,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  try {
    await withRequestContext(db.app, context, async () => {
      throw new Rollback((await db.app.query(sql, values)).rowCount ?? 0);
    });
  } catch (error) {
    if (error instanceof Rollback) {
      return error.rowCount;
    }
    throw error;
  }
  throw new Error("unreachable: the probe always rolls back");
}

/** Like `touched`, but a refusal by grant counts as reaching nothing; any other error fails the test. */
async function reached(
  db: TestDatabase,
  context: RequestContext,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  try {
    return await touched(db, context, sql, values);
  } catch (error) {
    expect(String(error), sql).toMatch(/permission denied/);
    return 0;
  }
}

async function updatableColumns(db: TestDatabase, table: string): Promise<string[]> {
  const { rows } = await db.owner.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.column_privileges
     WHERE grantee = 'questify_app' AND privilege_type = 'UPDATE' AND table_schema = 'public' AND table_name = $1
     ORDER BY 1`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function mayDelete(db: TestDatabase, table: string): Promise<boolean> {
  const { rows } = await db.owner.query<{ ok: boolean }>(
    "SELECT has_table_privilege('questify_app', $1, 'DELETE') AS ok",
    [`public.${table}`],
  );
  return rows[0]?.ok === true;
}

/** A value of the column taken from any row, to write without reading the column (no read rule applies). */
async function sampleValue(
  db: TestDatabase,
  table: string,
  column: string,
): Promise<string | null> {
  const { rows } = await db.owner.query<{ value: string | null }>(
    `SELECT "${column}"::text AS value FROM ${table} LIMIT 1`,
  );
  return rows[0]?.value ?? null;
}

/** Two organizers, each with an owner, a session, a sign-in challenge, a reset link, an audit entry and add-ons. */
async function seedFixtures(db: TestDatabase): Promise<Fixtures> {
  const base = await seedTwoTenants(db.owner);
  const run = (sql: string, values: unknown[]) => db.owner.query<{ id: string }>(sql, values);
  const publicEventB = (
    await run(
      "INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at) VALUES ($1, 'TABUK2', 'Open Day', 'live', now() - interval '1 hour', now() + interval '30 days') RETURNING id",
      [base.orgB],
    )
  ).rows[0]?.id;
  if (publicEventB === undefined) {
    throw new Error("Fixture: the public event of organizer B was not created.");
  }
  const staffA = await createStaff(db.owner, { email: "owner@najd.test" });
  const staffB = await createStaff(db.owner, { email: "owner@tabuk.test" });
  const categoryB = (await run("SELECT id FROM category WHERE event_id = $1", [base.eventB]))
    .rows[0]?.id;
  if (categoryB === undefined) {
    throw new Error("Fixture: organizer B's event has no General category.");
  }
  const f: Fixtures = { ...base, publicEventB, staffA, staffB, categoryB };
  for (const [org, staff, events] of [
    [f.orgA, staffA, [f.eventA]],
    [f.orgB, staffB, [f.eventB, publicEventB]],
  ] as const) {
    await run(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org, staff],
    );
    await run("INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)", [
      staff,
      hash(),
    ]);
    await run(
      "INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')",
      [staff, hash(), hash()],
    );
    await run(
      "INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
      [staff, hash()],
    );
    for (const document of ["organizer_terms", "organizer_dpa", "organizer_content_rules"]) {
      await run(
        "INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by) VALUES ($1, $2, '0.1', $3)",
        [org, document, staff],
      );
    }
    await run(
      "INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, 'editor', $3, $4, now() + interval '7 days')",
      [org, `invited.${org.slice(0, 8)}@team.test`, hash(), staff],
    );
    await run(
      "INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type) VALUES ('staff', $1, $2, 'event.seed', 'event')",
      [staff, org],
    );
    for (const event of events) {
      await run(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event, org],
      );
      await run(
        "INSERT INTO event_exclusion (organizer_id, event_id, kind, value, created_by) VALUES ($1, $2, 'email_domain', 'seeded.sa', $3)",
        [org, event, staff],
      );
      await run(
        "INSERT INTO event_activation_request (event_id, organizer_id, state, requested_by) VALUES ($1, $2, 'pending', $3)",
        [event, org, staff],
      );
      await run(
        "INSERT INTO event_limit_alert (event_id, organizer_id, level, players) VALUES ($1, $2, 80, 8)",
        [event, org],
      );
      rehearsalSeeds += 1;
      await run("INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)", [
        event,
        org,
        `SEED-${"ABCDEFGHJK".charAt(rehearsalSeeds)}222`,
      ]);
      await run(
        "INSERT INTO event_join_field (event_id, kind, label_en, position) VALUES ($1, 'custom', 'Seeded', 0)",
        [event],
      );
      await run(
        "INSERT INTO event_guest (event_id, kind, value) VALUES ($1, 'email', 'seeded@guest.test')",
        [event],
      );
      await run(
        "INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) SELECT n.id, j.id, n.organizer_id, n.event_id, 'Seeded' FROM enrollment n JOIN event_join_field j ON j.event_id = n.event_id WHERE n.event_id = $1",
        [event],
      );
      await run(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) SELECT $1, id, 'scan_qr', 'Seeded', 5 FROM category WHERE event_id = $1",
        [event],
      );
      // A passport and its step in one transaction: a passport is never left with fewer steps than it needs.
      await run("BEGIN", []);
      await run(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, verification)
         SELECT $1, id, 'passport', 'Seeded passport', 5, '{"needed":1}', '{}' FROM category WHERE event_id = $1`,
        [event],
      );
      await run(
        "INSERT INTO passport_step (event_id, quest_id, name_en) SELECT $1, id, 'Seeded' FROM quest WHERE event_id = $1 AND type = 'passport'",
        [event],
      );
      await run("COMMIT", []);
      await run(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Seeded', 1, 5)",
        [event],
      );
      await run(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 1, 'experience', 'Seeded')",
        [event],
      );
      await run(
        "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Seeded', 5)",
        [event],
      );
    }
  }
  for (const [reward, event] of [
    [CODE_REWARD_A, f.eventA],
    [CODE_REWARD_B, f.eventB],
  ] as const) {
    await run(
      "INSERT INTO reward (id, event_id, kind, name_en, price, stock_total) VALUES ($1, $2, 'digital', 'Code', 1, 1)",
      [reward, event],
    );
    await run(
      "INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash) SELECT organizer_id, event_id, id, $2, $3 FROM reward WHERE id = $1",
      [reward, randomBytes(40), randomBytes(32)],
    );
  }
  // One real completion and its points on each side, made by the completion engine itself (migration 0012).
  for (const [player, event] of [
    [f.playerA, f.eventA],
    [f.playerB, f.eventB],
  ] as const) {
    await db.owner.query("BEGIN");
    await db.owner.query("SELECT set_config('app.player_id', $1, true)", [player]);
    await db.owner.query(
      "SELECT complete_quest((SELECT id FROM quest WHERE event_id = $1 LIMIT 1), 'qr', 1, NULL, 'seed', NULL)",
      [event],
    );
    // And one reservation, made by the shop itself (migration 0024).
    await db.owner.query(
      "SELECT reserve_reward((SELECT id FROM reward WHERE event_id = $1 LIMIT 1), 'seed')",
      [event],
    );
    await db.owner.query("COMMIT");
  }
  // One operator on each side, limited to one quest, and one open personal invite (migration 0026).
  for (const [assignment, org, event, staff] of [
    [ASSIGNMENT_A, f.orgA, f.eventA, f.staffA],
    [ASSIGNMENT_B, f.orgB, f.eventB, f.staffB],
  ] as const) {
    const { rows } = await db.owner.query<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`crew_${assignment.slice(-1)}`],
    );
    await run(
      "INSERT INTO staff_assignment (id, organizer_id, event_id, player_id) VALUES ($1, $2, $3, $4)",
      [assignment, org, event, rows[0]?.id],
    );
    await run(
      "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) SELECT $1, event_id, id FROM quest WHERE event_id = $2 LIMIT 1",
      [assignment, event],
    );
    await run(
      "INSERT INTO operator_invite (organizer_id, event_id, kind, label, abilities, created_by, expires_at) VALUES ($1, $2, 'personal', 'Crew', '{scan_quests}', $3, now() + interval '1 day')",
      [org, event, staff],
    );
  }
  // One bulk award on each side, with its points and its note (migration 0030).
  for (const [org, event, staff] of [
    [f.orgA, f.eventA, f.staffA],
    [f.orgB, f.eventB, f.staffB],
  ] as const) {
    const bulk = await run(
      "INSERT INTO bulk_award (organizer_id, event_id, staff_user_id, amount, reason, requested, awarded, skipped, idempotency_key) VALUES ($1, $2, $3, 5, 'Seed', 1, 1, 0, 'seed') RETURNING id",
      [org, event, staff],
    );
    const entry = await run(
      "INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor, staff_user_id) SELECT organizer_id, event_id, id, 'award', 5, 5, 'staff', $2 FROM enrollment WHERE event_id = $1 LIMIT 1 RETURNING id",
      [event, staff],
    );
    await run(
      "INSERT INTO ledger_note (entry_id, organizer_id, event_id, bulk_id) VALUES ($1, $2, $3, $4)",
      [entry.rows[0]?.id, org, event, bulk.rows[0]?.id],
    );
  }
  // Rows past their retention, which the sweeps may remove whoever runs them.
  await run(
    "INSERT INTO staff_session (staff_user_id, token_hash, created_at, last_seen_at, revoked_at) VALUES ($1, $2, now() - interval '40 days', now() - interval '40 days', now() - interval '35 days')",
    [staffB, hash()],
  );
  await run(
    "INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at, created_at) VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '2 days')",
    [staffB, hash(), hash()],
  );
  await run(
    "INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at, created_at) VALUES ($1, $2, now() - interval '2 days', now() - interval '2 days')",
    [staffB, hash()],
  );
  await run(
    "INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, 'aged@team.test', 'editor', $2, $3, now() - interval '40 days')",
    [f.orgB, hash(), staffB],
  );
  for (const [email, age] of [
    [SIGNUP_A, "0 seconds"],
    [SIGNUP_B, "0 seconds"],
    [SIGNUP_B, "2 days"],
  ] as const) {
    await run(
      `INSERT INTO staff_signup (token_hash, code_hash, email, organizer_name, accepted_terms, accepted_dpa, accepted_content, expires_at, created_at)
       VALUES ($1, $2, $3, 'Pending Co', '0.1', '0.1', '0.1', now() + interval '10 minutes', now() - interval '${age}')`,
      [hash(), hash(), email],
    );
  }
  return f;
}

const contextFor = (f: Fixtures, seat: Seat): RequestContext =>
  seat === "organizer"
    ? { organizerId: f.orgA, staffUserId: f.staffA }
    : seat === "staff"
      ? { staffUserId: f.staffA }
      : { playerId: f.playerA };

const probes = Object.entries(OWNED).flatMap(([table, owned]) =>
  owned.probes.map((probe) => [table, probe.seat, probe] as const),
);

describe.skipIf(TEST_DATABASE_URL === undefined)("cross-tenant isolation (database)", () => {
  let db: TestDatabase;
  let f: Fixtures;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedFixtures(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const asA = <T extends Record<string, unknown>>(seat: Seat, sql: string, values: unknown[]) =>
    withRequestContext(db.app, contextFor(f, seat), async () => db.app.query<T>(sql, values));

  const count = async (seat: Seat | "owner", sql: string, values: unknown[]): Promise<number> => {
    const query = `SELECT count(*)::int AS n FROM ${sql}`;
    const result =
      seat === "owner"
        ? await db.owner.query<{ n: number }>(query, values)
        : await asA<{ n: number }>(seat, query, values);
    return result.rows[0]?.n ?? -1;
  };

  const press = (seat: Seat, event: string, category: string) =>
    asA(seat, "SELECT * FROM send_category_hint($1, $2, $3, $4)", [
      event,
      category,
      randomUUID(),
      randomUUID(),
    ]);

  it("keeps all announcement doors inside the caller's tenant and membership", async () => {
    for (const seat of ["organizer", "staff", "player"] as const) {
      const calls = [
        ["SELECT announcement_list($1)", [f.eventB]],
        ["SELECT announcement_list($1, true, now(), $2)", [f.eventB, randomUUID()]],
        ["SELECT * FROM announcement_preview($1)", [f.eventB]],
        [
          "SELECT * FROM announcement_send($1, '{}'::jsonb, NULL, $2, $3)",
          [f.eventB, randomUUID(), randomUUID()],
        ],
        ["SELECT announcement_cancel($1, $2, $3)", [f.eventB, randomUUID(), randomUUID()]],
      ] as const;
      for (const [sql, values] of calls)
        expect(await refusal(asA(seat, sql, [...values]))).toBe("AN404");
      expect(await refusal(asA(seat, "SELECT member_announcements($1, 50)", [f.eventB]))).toBe(
        "AM403",
      );
    }
    expect(await count("owner", "announcement WHERE event_id = $1", [f.eventB])).toBe(0);
  });

  it("keeps the streak doors inside their tenant and their player (T-405)", async () => {
    const organizer = contextFor(f, "organizer");
    expect(
      await refusal(
        asA("organizer", "SELECT set_event_streak($1, true, 5, '{}', '{}', $2)", [
          f.eventB,
          randomUUID(),
        ]),
      ),
    ).toBe("AN404");
    expect(await refusal(asA("organizer", "SELECT event_streak_settings($1)", [f.eventB]))).toBe(
      "AN404",
    );
    expect(await refusal(asA("organizer", "SELECT event_streak_settings($1)", [f.eventA]))).toBe(
      "none",
    );
    expect(await count("owner", "event_streak WHERE event_id = $1", [f.eventB])).toBe(0);
    expect((await asA("player", "SELECT * FROM own_event_streak($1)", [f.eventB])).rows).toEqual(
      [],
    );
    expect(
      (await asA("player", "SELECT * FROM own_event_streak($1)", [f.eventA])).rows,
    ).toHaveLength(1);
    // An organizer seat has no player: no daily streak and no streak bonus of anyone's completion.
    const seen = await withRequestContext(db.app, organizer, async () =>
      db.app.query("SELECT own_daily_streak() AS d"),
    );
    expect(seen.rows).toEqual([{ d: null }]);
    // No door the API role holds reads the Questify days apart from the caller-bound two.
    const { rows } = await db.owner.query<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('questify_app', p.oid, 'EXECUTE')
         AND p.prosrc ~ '(questify_streak_day|daily_streak_of|daily_streak_length|questify_streak_reward)'
       ORDER BY 1`,
    );
    expect(rows.map((row) => row.name)).toEqual(["own_daily_streak", "questify_sync"]);
  });

  it("keeps the invitation doors inside their tenant (T-409)", async () => {
    await db.owner.query(
      `INSERT INTO platform_setting (key, value) VALUES ('features', '{"invitationCampaigns": {"enabled": true}}')
       ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
    );
    const { rows } = await db.owner.query<{ id: string }>(
      `INSERT INTO invitation_campaign (organizer_id, event_id, request_id, fingerprint, size)
       VALUES ($1, $2, gen_random_uuid(), 'b', 50) RETURNING id`,
      [f.orgB, f.publicEventB],
    );
    const theirs = rows[0]?.id;
    const key = randomUUID();
    expect(await refusal(asA("organizer", "SELECT invitation_list($1)", [f.publicEventB]))).toBe(
      "IV404",
    );
    expect(
      await refusal(
        asA("organizer", `SELECT invitation_request($1, '{"size": 50}', $2)`, [
          f.publicEventB,
          key,
        ]),
      ),
    ).toBe("IV404");
    for (const event of [f.publicEventB, f.eventA]) {
      expect(
        await refusal(
          asA("organizer", "SELECT invitation_cancel($1, $2, $3)", [event, theirs, key]),
        ),
      ).toBe("IV404");
    }
    for (const seat of ["staff", "player"] as const) {
      expect(await refusal(asA(seat, "SELECT invitation_list($1)", [f.publicEventB]))).toBe(
        "IV404",
      );
    }
    // Only an active platform admin reaches the console's doors; a team seat is refused like anyone else.
    expect(await refusal(asA("organizer", "SELECT invitation_admin_get($1)", [theirs]))).toBe(
      "QY403",
    );
    expect(
      await count("owner", "invitation_campaign WHERE state = 'requested' AND id = $1", [theirs]),
    ).toBe(1);
    await db.owner.query("DELETE FROM invitation_campaign WHERE id = $1", [theirs]);
  });

  it("keeps the notification center, mutes and devices to the calling player (T-501)", async () => {
    await db.owner.query(
      `INSERT INTO notice_kind (kind, class, priority, ttl) VALUES ('tenant_probe', 'personal', 0, '1 day')`,
    );
    const { rows } = await db.owner.query<{ id: string; player_id: string }>(
      `WITH n AS (INSERT INTO notice (kind, player_id, audience, dedupe, expires_at, fanned_at)
                  SELECT 'tenant_probe', p, 'player', 'tenant_probe:' || p, now() + interval '1 day', now()
                  FROM unnest(ARRAY[$1::uuid, $2::uuid]) p RETURNING id, player_id)
       INSERT INTO notification (notice_id, player_id) SELECT id, player_id FROM n RETURNING id, player_id`,
      [f.playerA, f.playerB],
    );
    const mine = rows.find((row) => row.player_id === f.playerA)?.id;
    const theirs = rows.find((row) => row.player_id === f.playerB)?.id;
    const listed = await asA<{ r: Array<{ id: number }> }>(
      "player",
      "SELECT own_notifications(NULL, 50) AS r",
      [],
    );
    expect(listed.rows[0]?.r.map((row) => String(row.id))).toEqual([mine]);
    await asA("player", "SELECT mark_notifications_read($1::bigint[])", [[theirs]]);
    expect(await count("owner", "notification WHERE id = $1 AND read_at IS NULL", [theirs])).toBe(
      1,
    );
    await asA("player", "SELECT mark_notifications_read(NULL)", []);
    expect(await count("owner", "notification WHERE id = $1 AND read_at IS NULL", [theirs])).toBe(
      1,
    );
    // A team seat has no player: no center, no topics, no device, and no table right at all.
    for (const seat of ["organizer", "staff"] as const) {
      expect(await refusal(asA(seat, "SELECT own_notifications(NULL, 50)", []))).toBe("PN401");
      expect(await refusal(asA(seat, "SELECT mark_notifications_read(NULL)", []))).toBe("PN401");
      expect(await refusal(asA(seat, "SELECT own_push_topics()", []))).toBe("PN401");
      expect(await refusal(asA(seat, "SELECT set_push_topics('{rank}')", []))).toBe("PN401");
      expect(await refusal(asA(seat, "SELECT push_device_remove($1)", [Buffer.alloc(32)]))).toBe(
        "PN401",
      );
      expect(
        (await asA<{ n: number }>(seat, "SELECT own_unread_notifications() AS n", [])).rows,
      ).toEqual([{ n: 0 }]);
    }
    for (const seat of ["organizer", "staff", "player"] as const) {
      for (const table of [
        "notification",
        "notice",
        "push_device",
        "push_send",
        "push_topic_mute",
        "notice_kind",
      ]) {
        expect(await refusal(asA(seat, `SELECT 1 FROM ${table} LIMIT 1`, [])), table).toBe("42501");
      }
      expect(await refusal(asA(seat, "SELECT * FROM push_claim('{fcm}', 1)", []))).toBe("PN403");
      // The due scans write notices for every tenant's reservations and event moments: the system seat only
      // (T-501d, T-501e; T-501f's streak and shop scans too).
      expect(await refusal(asA(seat, "SELECT push_due()", []))).toBe("PN403");
      // The invitation hand-off writes promotional notices for every tenant's campaigns: the system seat only (T-501f).
      expect(await refusal(asA(seat, "SELECT invitation_push_hand()", []))).toBe("IV403");
    }
    await db.owner.query("DELETE FROM notice WHERE kind = 'tenant_probe'");
    await db.owner.query("DELETE FROM notice_kind WHERE kind = 'tenant_probe'");
  });

  it("keeps organizer alert switches to the calling member and the rank push and alert sender to the system (T-503)", async () => {
    // B's owner has switched one type off: A's seat must neither read nor change it.
    await db.owner.query(
      "INSERT INTO organizer_alert_switch (organizer_id, staff_user_id, alert_type, enabled) VALUES ($1, $2, 'activated', false)",
      [f.orgB, f.staffB],
    );
    const outboxOfB = await count("owner", "organizer_alert WHERE organizer_id = $1", [f.orgB]);
    // A's member reads and sets only their own switches, and only for their own organizer.
    const own = await asA<{ r: Record<string, boolean> }>(
      "organizer",
      "SELECT own_alert_switches($1) AS r",
      [f.orgA],
    );
    expect(own.rows[0]?.r["activated"]).toBe(true);
    for (const seat of ["organizer", "staff", "player"] as const) {
      expect(await refusal(asA(seat, "SELECT own_alert_switches($1)", [f.orgB])), seat).toBe(
        "AL404",
      );
      expect(
        await refusal(
          asA(seat, "SELECT set_own_alert_switches($1, $2::jsonb, NULL)", [
            f.orgB,
            JSON.stringify({
              activated: true,
              stock_low: true,
              codes_low: true,
              new_flags: true,
              content_unpublished: true,
              support_access: true,
              size_limit: true,
            }),
          ]),
        ),
        seat,
      ).toBe("AL404");
      for (const table of ["organizer_alert_switch", "organizer_alert", "rank_top_snapshot"]) {
        expect(await refusal(asA(seat, `SELECT 1 FROM ${table} LIMIT 1`, [])), table).toBe("42501");
        expect(await refusal(asA(seat, `DELETE FROM ${table}`, [])), table).toBe("42501");
      }
      // The sender, the flag scan and the rank tick write for every tenant: the system seat only.
      for (const call of [
        "SELECT * FROM alert_claim(5)",
        "SELECT alert_settle(true)",
        "SELECT alert_scan_flags(10)",
        "SELECT * FROM rank_push_events(10)",
      ]) {
        expect(await refusal(asA(seat, call, [])), call).toBe("PN403");
      }
      expect(await refusal(asA(seat, "SELECT rank_push_diff($1)", [f.eventB])), seat).toBe("PN403");
    }
    expect(
      await count("owner", "organizer_alert_switch WHERE organizer_id = $1 AND enabled", [f.orgB]),
    ).toBe(0);
    expect(await count("owner", "organizer_alert WHERE organizer_id = $1", [f.orgB])).toBe(
      outboxOfB,
    );
    await db.owner.query("DELETE FROM organizer_alert_switch WHERE organizer_id = $1", [f.orgB]);
  });

  it("keeps the hidden-category hint to the team that edits the event, and the reveal to the fan-out (T-501g)", async () => {
    const hidden = async (event: string) =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO category (event_id, name_en, hidden) VALUES ($1, 'Secret garden', true) RETURNING id",
          [event],
        )
      ).rows[0]?.id ?? "";
    const mine = await hidden(f.eventA);
    const theirs = await hidden(f.eventB);
    // B's event, B's category, and B's category through A's own event: A's team finds nothing to hint.
    for (const [event, category] of [
      [f.eventB, theirs],
      [f.eventA, theirs],
    ] as const) {
      expect(await refusal(press("organizer", event, category))).toBe("AN404");
      expect(
        await refusal(
          asA("organizer", "SELECT * FROM category_hint_preview($1, $2)", [event, category]),
        ),
      ).toBe("AN404");
    }
    // Staff on their own and a player have no organizer or no staff seat: no event of A's or B's is theirs to hint.
    for (const seat of ["staff", "player"] as const) {
      for (const [event, category] of [
        [f.eventA, mine],
        [f.eventB, theirs],
      ] as const) {
        expect(await refusal(press(seat, event, category)), seat).toBe("AN404");
        expect(
          await refusal(
            asA(seat, "SELECT * FROM category_hint_preview($1, $2)", [event, category]),
          ),
          seat,
        ).toBe("AN404");
      }
    }
    expect(await count("owner", "notice WHERE kind = 'category_hint'", [])).toBe(0);
    // Nobody but the fan-out writes a reveal: no seat runs it, reads the table or writes to it.
    for (const seat of ["organizer", "staff", "player"] as const) {
      expect(await refusal(asA(seat, "SELECT push_fan_out()", [])), seat).toBe("PN403");
      expect(await refusal(asA(seat, "SELECT 1 FROM category_reveal LIMIT 1", [])), seat).toBe(
        "42501",
      );
      expect(
        await refusal(
          asA(
            seat,
            "INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id) VALUES ($1, $2, $3, $4)",
            [f.orgB, f.eventB, randomUUID(), theirs],
          ),
        ),
        seat,
      ).toBe("42501");
    }
    // A's own team hints A's own category; B's stays untouched.
    expect((await press("organizer", f.eventA, mine)).rows).toEqual([
      { sent: true, replayed: false },
    ]);
    expect(
      await count("owner", "notice WHERE kind = 'category_hint' AND event_id = $1", [f.eventA]),
    ).toBe(1);
    expect(
      await count("owner", "notice WHERE kind = 'category_hint' AND event_id = $1", [f.eventB]),
    ).toBe(0);
    expect(
      await count("owner", "category_reveal WHERE category_id = ANY ($1)", [[mine, theirs]]),
    ).toBe(0);
    await db.owner.query("DELETE FROM notice WHERE kind = 'category_hint'");
    await db.owner.query("DELETE FROM category WHERE id = ANY ($1)", [[mine, theirs]]);
  });

  it("keeps the recap to the calling player and their own events (T-410)", async () => {
    const recap = "SELECT status_now FROM event_recap($1)";
    expect((await asA("player", recap, [f.eventA])).rows).toEqual([{ status_now: "live" }]);
    for (const event of [f.eventB, f.publicEventB]) {
      expect((await asA("player", recap, [event])).rows).toEqual([]);
    }
    // A team seat has no player: no recap of anyone, its own events included.
    for (const seat of ["organizer", "staff"] as const) {
      expect((await asA(seat, recap, [f.eventA])).rows).toEqual([]);
    }
    // B's event: organizer A can neither change its window nor see it move.
    const days = "UPDATE event SET shop_days_after = 9 WHERE id = $1 RETURNING id";
    expect((await asA("organizer", days, [f.eventB])).rows).toEqual([]);
    expect(await count("owner", "event WHERE id = $1 AND shop_days_after = 9", [f.eventB])).toBe(0);
  });

  it("gives no seat a hand in archiving: A's call moves B's events by the rule alone, as the system (T-411)", async () => {
    // B's private events: one due (ended 31 days ago, revealed, nothing held), one not (its shop still open).
    const ended = async (code: string, endedAgo: string) => {
      const { rows } = await db.owner.query<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
         VALUES ($1, $2, 'Archive B', 'ended', 'private', now() - $3::interval - interval '1 day',
                 now() - $3::interval)
         RETURNING id`,
        [f.orgB, code, endedAgo],
      );
      await db.owner.query(
        `INSERT INTO event_result (event_id, organizer_id, revealed_at, claim_until)
         VALUES ($1, $2, now(), now() + interval '1 day')`,
        [rows[0]?.id, f.orgB],
      );
      return rows[0]?.id ?? "";
    };
    const due = await ended("ARCHB1", "31 days");
    const notDue = await ended("ARCHB2", "1 day");
    const untouched = [f.eventA, f.eventB, f.publicEventB, notDue];
    const before = await db.owner.query<{ id: string; status: string }>(
      "SELECT id, status FROM event WHERE id = ANY($1) ORDER BY id",
      [untouched],
    );
    for (const seat of ["organizer", "staff", "player"] as const) {
      await asA(seat, "SELECT archive_ended_events()", []);
    }
    const after = await db.owner.query(
      "SELECT id, status FROM event WHERE id = ANY($1) ORDER BY id",
      [untouched],
    );
    expect(after.rows).toEqual(before.rows);
    // The due one goes by the rule, once, audited as the system: no seat of A is named on B's row.
    const moved = await db.owner.query(
      `SELECT e.status, a.actor_type, a.actor_id, a.organizer_id FROM event e
       JOIN audit_log a ON a.event_id = e.id AND a.after ->> 'status' = 'archived' WHERE e.id = $1`,
      [due],
    );
    expect(moved.rows).toEqual([
      { status: "archived", actor_type: "system", actor_id: null, organizer_id: f.orgB },
    ]);
    // Organizer A can write no status, B's event included: the column was never granted.
    for (const event of [f.eventA, f.eventB]) {
      expect(
        await refusal(
          asA("organizer", "UPDATE event SET status = 'archived' WHERE id = $1", [event]),
        ),
      ).toBe("42501");
    }
  });

  it("classifies every table as owned (tested here) or shared (with a reason)", async () => {
    const { rows } = await db.owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    expect(rows.map((row) => row.name)).toEqual(
      [...Object.keys(OWNED), ...Object.keys(SHARED)].toSorted(),
    );
  });

  describe.each(probes)("%s, from the %s seat", (table, _seat, spec) => {
    const theirs = () => spec.theirs(f);
    const where = `${table} WHERE ${spec.column} = $1`;

    it("has rows of both sides to test against", async () => {
      expect(await count("owner", where, [spec.mine(f)])).toBeGreaterThan(0);
      expect(await count("owner", where, [theirs()])).toBeGreaterThan(0);
      if (spec.ownRowsHidden === undefined) {
        expect(await count(spec.seat, where, [spec.mine(f)])).toBeGreaterThan(0);
      }
    });

    it("shows A none of B's rows, apart from what is public by design", async () => {
      const open = spec.publicRows?.(f);
      const expected =
        open === undefined
          ? 0
          : await count("owner", `${where} AND (${open.sql})`, [theirs(), ...open.values]);
      expect(await count(spec.seat, where, [theirs()])).toBe(expected);
    });

    it("lets A change none of B's rows it can see, through any column it may update", async () => {
      for (const column of await updatableColumns(db, table)) {
        const result = await asA(
          spec.seat,
          `UPDATE ${table} SET "${column}" = "${column}" WHERE ${spec.column} = $1`,
          [theirs()],
        );
        expect(result.rowCount, `${table}.${column}`).toBe(0);
      }
    });

    it("refuses A writing a row in B's name", async () => {
      const forged = spec.forge(f);
      await expect(asA(spec.seat, forged.sql, forged.values)).rejects.toThrow(
        spec.forgeRefusedBy ?? POLICY,
      );
    });
  });

  describe.each(probes)("%s, bare writes from an empty-handed %s seat", (table, seat) => {
    // No WHERE and no column read, so the read rule does not narrow the rows: only the update and delete rules do.
    it("reaches no row through any column it may update", async () => {
      for (const column of await updatableColumns(db, table)) {
        const value = await sampleValue(db, table, column);
        const sql = `UPDATE ${table} SET "${column}" = $1`;
        expect(await reached(db, emptyHanded(seat), sql, [value]), column).toBe(0);
      }
    });

    it("deletes nothing, or only rows past their retention", async () => {
      const sweep = OWNED[table]?.sweep;
      const expected =
        sweep === undefined ? 0 : await count("owner", `${table} WHERE ${sweep("")}`, []);
      if (sweep !== undefined) {
        expect(expected, "an aged row is seeded to test the sweep boundary").toBeGreaterThan(0);
      }
      if (await mayDelete(db, table)) {
        expect(await reached(db, emptyHanded(seat), `DELETE FROM ${table}`)).toBe(expected);
      } else {
        await expect(touched(db, emptyHanded(seat), `DELETE FROM ${table}`)).rejects.toThrow(
          /permission denied/,
        );
      }
    });
  });
});

/**
 * Bare writes from A's real seats. A real member can be widened by a rule that the empty-handed seat never meets
 * (for example an owner check on the caller's organizer instead of the row's), and A's own rows make the row count
 * useless. So this database gets test-only detector triggers: for the API's role, touching one of B's rows (outside a
 * retention sweep) raises, and every other row is skipped so no guard of A's own rows can hide it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("cross-tenant isolation (real seats)", () => {
  const DETECTED = "cross-tenant detector";
  let db: TestDatabase;
  let f: Fixtures;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedFixtures(db);
    await db.owner.query(`
      CREATE FUNCTION test_detect_reach() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '${DETECTED}: % reached a row of B', TG_TABLE_NAME;
      END $$;
      CREATE FUNCTION test_skip_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NULL;
      END $$;`);
    for (const [table, owned] of Object.entries(OWNED)) {
      for (const [index, probe] of owned.probes.entries()) {
        const sweep = owned.sweep === undefined ? "" : ` AND NOT (${owned.sweep("OLD.")})`;
        // Trigger names sort first ("a0", "a1"), so they run before the table's own guards.
        await db.owner.query(
          `CREATE TRIGGER a0_detect_${index} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW
           WHEN (current_user = 'questify_app' AND OLD.${probe.column}::text = '${probe.theirs(f)}'${sweep})
           EXECUTE FUNCTION test_detect_reach()`,
        );
      }
      await db.owner.query(
        `CREATE TRIGGER a1_skip BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW
         WHEN (current_user = 'questify_app') EXECUTE FUNCTION test_skip_row()`,
      );
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it("has a detector on every owned table, and it fires when a B row is reached", async () => {
    const { rows } = await db.owner.query<{ table: string; n: number }>(
      `SELECT c.relname AS table, count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname LIKE 'a0_detect_%' GROUP BY 1 ORDER BY 1`,
    );
    expect(rows).toEqual(
      Object.entries(OWNED)
        .map(([table, owned]) => ({ table, n: owned.probes.length }))
        .toSorted((a, b) => a.table.localeCompare(b.table)),
    );
    // A Questify admin may remove any team member, so this reaches B's row on purpose.
    await expect(
      touched(db, { isAdmin: true }, "DELETE FROM organizer_member WHERE organizer_id = $1", [
        f.orgB,
      ]),
    ).rejects.toThrow(new RegExp(DETECTED));
  });

  describe.each(probes)("%s, bare writes from A's %s seat", (table, seat) => {
    it("touches none of B's rows through any column it may update", async () => {
      for (const column of await updatableColumns(db, table)) {
        const value = await sampleValue(db, table, column);
        const sql = `UPDATE ${table} SET "${column}" = $1`;
        expect(await reached(db, contextFor(f, seat), sql, [value]), column).toBe(0);
      }
    });

    it("deletes none of B's rows", async () => {
      expect(await reached(db, contextFor(f, seat), `DELETE FROM ${table}`)).toBe(0);
    });
  });
});
