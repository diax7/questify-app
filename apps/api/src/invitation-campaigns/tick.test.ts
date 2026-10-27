import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { invitationToken } from "#src/invitation-campaigns/message";
import {
  INVITATION_BUDGET_MS,
  INVITATION_ROUND,
  INVITATION_SETTLE_MS,
  messageOf,
  startInvitationTick,
} from "#src/invitation-campaigns/tick";
import type { SmsMessage, SmsResult, SmsSender } from "#src/players/sms";

type Logged = { level: string; fields: Record<string, unknown> };
type Script = {
  /** How many rows each claim returns, in order; afterwards none. */
  claims: number[];
  start?: string;
  /** settle's `more` answers, in order; afterwards false. */
  more?: boolean[];
  ackFails?: boolean;
  /** Claims with no approved name, so the text cannot be built. */
  blankNames?: boolean;
};

const NOON = Date.parse("2026-10-27T12:00:00+03:00");
const keys = createAuthKeys("k".repeat(40));
const claimRow = (n: number) => ({
  recipient_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  lease: `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`,
  channel: "sms",
  language: n % 2 === 0 ? "ar" : "en",
  phone: `+96650000${String(n).padStart(4, "0")}`,
  player_id: `22222222-0000-4000-8000-${String(n).padStart(12, "0")}`,
  link: `33333333-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name_ar: "مهرجان الرياض",
  name_en: "Riyadh Festival",
});

/** A pool answering the tick's statements from `script`, recording each statement and its values. */
function fakePool(script: Script) {
  const statements: { sql: string; values: unknown[]; timeout?: number }[] = [];
  let claimed = 0;
  let settles = 0;
  let next = 0;
  const client = {
    query: vi.fn(
      async (asked: string | { text: string; query_timeout?: number }, values: unknown[] = []) => {
        const sql = typeof asked === "string" ? asked : asked.text;
        statements.push({
          sql,
          values,
          ...(typeof asked === "string" || asked.query_timeout === undefined
            ? {}
            : { timeout: asked.query_timeout }),
        });
        if (sql.includes("invitation_settle")) {
          settles += 1;
          return { rows: [{ summary: { more: script.more?.[settles - 1] ?? false } }] };
        }
        if (sql.includes("invitation_start_due"))
          return { rows: [{ outcome: script.start ?? "idle" }] };
        if (sql.includes("invitation_claim")) {
          const count = script.claims[claimed] ?? 0;
          claimed += 1;
          const blank = script.blankNames === true ? { name_ar: null, name_en: null } : {};
          return {
            rows: Array.from({ length: count }, () => ({ ...claimRow((next += 1)), ...blank })),
          };
        }
        if (sql.includes("invitation_ack") && script.ackFails === true) {
          throw Object.assign(new Error("database down"), { code: "57P01" });
        }
        return { rows: [] };
      },
    ),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

const settingsWith = (enabled: boolean | undefined) => ({
  forEvent: vi.fn(async () => ({
    kind: "ok" as const,
    config: { features: enabled === undefined ? {} : { invitationCampaigns: { enabled } } },
  })),
});

/** A sender answering every message with `answer`, recording what it was asked to send. */
function recordingSender(answer: (message: SmsMessage) => SmsResult | Promise<SmsResult>) {
  const sent: SmsMessage[] = [];
  const sender: SmsSender = {
    name: "recording",
    send: async (message) => {
      sent.push(message);
      return answer(message);
    },
  };
  return { sender, sent };
}

type Options = {
  enabled?: boolean;
  sender?: SmsSender | null;
  clock?: () => number;
};

function start(script: Script, logged: Logged[], options: Options = {}) {
  const fake = fakePool(script);
  const recording = recordingSender(() => ({ kind: "sent" }));
  const sender = options.sender === null ? undefined : (options.sender ?? recording.sender);
  const tick = startInvitationTick({
    pool: fake.pool,
    settings: settingsWith(options.enabled ?? true) as never,
    ...(sender === undefined ? {} : { promoSms: sender }),
    keys,
    intervalMs: 1000,
    random: () => 0.5,
    now: options.clock ?? (() => NOON),
    log: (level, fields) => logged.push({ level, fields }),
  });
  return { tick, statements: fake.statements, sent: recording.sent };
}

const named = (statements: { sql: string; values: unknown[] }[], name: string) =>
  statements.filter((statement) => statement.sql.includes(name));

describe("startInvitationTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles first (every 10 minutes), starts one due campaign, then claims rounds of 5 and acknowledges each", async () => {
    const logged: Logged[] = [];
    const { tick, statements, sent } = start({ claims: [5, 5, 2], start: "started" }, logged);
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    const order = statements
      .map((statement) => statement.sql)
      .filter((sql) => sql.includes("invitation_"));
    expect(order[0]).toContain("invitation_settle");
    expect(order[1]).toContain("invitation_start_due");
    const fill = statements.findIndex((statement) =>
      statement.sql.includes("invitation_start_due"),
    );
    // The fill's own limits: the server's for this transaction and the client's for this query (ADR-334 (4)).
    expect(statements[fill - 1]?.sql).toBe("SET LOCAL statement_timeout = 60000");
    expect(statements[fill]?.timeout).toBe(65_000);
    expect(named(statements, "invitation_claim").map((s) => s.values)).toEqual([
      [["sms"], INVITATION_ROUND],
      [["sms"], INVITATION_ROUND],
      [["sms"], INVITATION_ROUND],
      [["sms"], INVITATION_ROUND],
    ]);
    expect(sent).toHaveLength(12);
    const acks = named(statements, "invitation_ack");
    expect(acks).toHaveLength(12);
    expect(acks[0]?.values).toEqual([claimRow(1).recipient_id, claimRow(1).lease, "sent", null]);
    expect(logged).toEqual([
      { level: "info", fields: { event: "invitation.start", outcome: "started" } },
    ]);
  });

  it("sends the rendered text to the claimed phone, and never logs a phone or a text", async () => {
    const logged: Logged[] = [];
    const { tick, sent } = start({ claims: [1] }, logged);
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    const row = claimRow(1);
    expect(sent).toEqual([{ to: row.phone, text: messageOf({ keys }, row as never) }]);
    expect(sent[0]?.text).toContain(`https://questify.sa/en/i#${invitationToken(row.link)}`);
    expect(sent[0]?.text).toContain("Invitation to Riyadh Festival: ");
    expect(JSON.stringify(logged)).not.toContain(row.phone);
  });

  it("claims no further round after an account refusal, and raises the hold alert", async () => {
    const logged: Logged[] = [];
    const answers: SmsResult[] = [
      { kind: "sent" },
      { kind: "refused", reason: "1060" },
      { kind: "sent" },
    ];
    let call = 0;
    const { sender } = recordingSender(() => answers[call++] ?? { kind: "sent" });
    const { tick, statements } = start({ claims: [3, 5, 5] }, logged, { sender });
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(named(statements, "invitation_claim")).toHaveLength(1);
    expect(named(statements, "invitation_ack").map((s) => s.values[2])).toEqual([
      "sent",
      "hold",
      "sent",
    ]);
    expect(logged).toContainEqual({
      level: "error",
      fields: { event: "invitation.channel_hold", channel: "sms", code: "1060" },
    });
  });

  it("stops claiming when the budget is spent", async () => {
    let clock = NOON;
    const { sender } = recordingSender(() => {
      clock += INVITATION_BUDGET_MS / 2;
      return { kind: "sent" };
    });
    const { tick, statements } = start({ claims: [1, 1, 1, 1] }, [], {
      sender,
      clock: () => clock,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(named(statements, "invitation_claim")).toHaveLength(2);
  });

  it.each([
    ["21:59:30", 0],
    ["08:59:00", 0],
    ["23:00:00", 0],
    ["09:00:00", 2],
  ])(
    "at %s Riyadh time asks for %i claims (quiet hours with the lease margin)",
    async (time, rounds) => {
      const at = Date.parse(`2026-10-27T${time}+03:00`);
      const { tick, statements } = start({ claims: [1] }, [], { clock: () => at });
      await vi.advanceTimersByTimeAsync(1000);
      await tick.stop();
      expect(named(statements, "invitation_claim")).toHaveLength(rounds);
      expect(named(statements, "invitation_start_due")).toHaveLength(1);
    },
  );

  it("with the switch off, only settles: nothing is started or claimed", async () => {
    const { tick, statements } = start({ claims: [5] }, [], { enabled: false });
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(named(statements, "invitation_settle")).toHaveLength(1);
    expect(named(statements, "invitation_start_due")).toHaveLength(0);
    expect(named(statements, "invitation_claim")).toHaveLength(0);
  });

  it("without a promotional sender, starts campaigns but claims nothing", async () => {
    const { tick, statements } = start({ claims: [5] }, [], { sender: null });
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(named(statements, "invitation_start_due")).toHaveLength(1);
    expect(named(statements, "invitation_claim")).toHaveLength(0);
  });

  it("settles again only after 10 minutes, and calls again while it reports more", async () => {
    let clock = NOON;
    const { tick, statements } = start({ claims: [], more: [true, true, false] }, [], {
      clock: () => clock,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(named(statements, "invitation_settle")).toHaveLength(3);
    clock += INVITATION_SETTLE_MS - 1;
    await vi.advanceTimersByTimeAsync(1000);
    expect(named(statements, "invitation_settle")).toHaveLength(3);
    clock += 1;
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(named(statements, "invitation_settle")).toHaveLength(4);
  });

  it("logs a failed acknowledgement by its SQLSTATE and carries on", async () => {
    const logged: Logged[] = [];
    const { tick, statements } = start({ claims: [2], ackFails: true }, logged);
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(named(statements, "invitation_claim")).toHaveLength(2);
    expect(logged.filter((entry) => entry.fields["event"] === "invitation.ack_failed")).toEqual([
      { level: "error", fields: { event: "invitation.ack_failed", code: "57P01" } },
      { level: "error", fields: { event: "invitation.ack_failed", code: "57P01" } },
    ]);
  });

  it("counts a sender that throws as unknown, never as sent", async () => {
    const thrower: SmsSender = {
      name: "broken",
      send: async () => {
        throw new Error("boom");
      },
    };
    const { tick, statements } = start({ claims: [1] }, [], { sender: thrower });
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(named(statements, "invitation_ack")[0]?.values.slice(2)).toEqual([
      "unknown",
      "sender_error",
    ]);
  });

  it("fails a message whose text cannot be built, without sending it or counting it as possibly sent", async () => {
    const logged: Logged[] = [];
    const { tick, statements, sent } = start({ claims: [2], blankNames: true }, logged);
    await vi.advanceTimersByTimeAsync(1000);
    await tick.stop();
    expect(sent).toEqual([]);
    expect(named(statements, "invitation_ack").map((s) => s.values.slice(2))).toEqual([
      ["failed", "render_error"],
      ["failed", "render_error"],
    ]);
  });

  it("stops: no run after stop", async () => {
    const { tick, statements } = start({ claims: [] }, []);
    await tick.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statements).toEqual([]);
  });
});
