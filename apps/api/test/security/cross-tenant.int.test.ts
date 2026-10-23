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
  xp_entry:
    "no right for the API role at all; append-only, written by the ledger's XP trigger (test/db/xp)",
  level_reached:
    "no right for the API role at all; append-only, written by the ledger's XP trigger, read through own_level (test/db/xp)",
  xp_level:
    "platform-wide curve; no right for the API role, read inside the XP definers (test/db/xp)",
  level_title:
    "platform-wide titles; no right for the API role, read through own_level (test/db/xp)",
  quest_vote:
    "no right for the API role at all; written by vote_quest, read by the voter through member_vote and by the event's team as counts through quest_vote_counts (test/db/vote-quiz)",
  survey_response:
    "no right for the API role at all; written by submit_survey, read by the event's team as totals and texts with names not shown through survey_summary; players read only whether they answered, through member_survey (test/db/challenge-survey-share)",
  quiz_attempt:
    "no right for the API role at all; written by quiz_start, quiz_next, quiz_answer and the sweep, read by the player through member_quiz (test/db/vote-quiz)",
  quiz_answer:
    "no right for the API role at all; written by quiz_next and quiz_answer, read by the player through member_quiz (test/db/vote-quiz)",
  submission:
    "no right for the API role at all; written by submit_quest and the review definers, read by the player through own_submissions and by the event's team through event_submissions and operator_submissions (test/db/submissions)",
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
      await run(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Seeded', 1, 5)",
        [event],
      );
      await run(
        "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 1, 'experience', 'Seeded')",
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
