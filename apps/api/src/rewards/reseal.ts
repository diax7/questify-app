import type { Client } from "pg";
import { recordAudit } from "#src/audit/record";
import {
  isCurrent,
  markCode,
  openCode,
  sealCode,
  type RewardCodeKeyring,
} from "#src/rewards/codes";

/** Rows read per batch; each batch's writes are one short transaction (plan review 88, item 2). */
export const RESEAL_BATCH = 100;
/** Ids listed per kind in the report; the counts are always whole. */
const LISTED_IDS = 100;
const UNIQUE_VIOLATION = "23505";
const LOCK_NOT_AVAILABLE = "55P03";

type CodeRow = { id: string; reward_id: string; event_id: string; code_cipher: Buffer };
type Outcome = "resealed" | "conflict" | "changed";
type Planned = Readonly<{ id: string; eventId: string; old: Buffer; cipher: Buffer; mark: Buffer }>;

/**
 * What a re-seal did. `current`: already sealed under the current key in the new format. `resealed`: sealed again
 * under it. `unreadable`: opened under no key held (left as is). `conflict`: its new mark is another row's in the same
 * event (the same code twice, only possible from data before T-810f or the rotation redeploy). `changed`: its cipher
 * changed after the read, or its lock was not granted in time; the next run takes it.
 */
export type ResealCounts = {
  current: number;
  resealed: number;
  unreadable: number;
  conflict: number;
  changed: number;
};

/** The counts and the row ids behind the three that need a rerun or a person; never a code, cipher or mark. */
export type ResealReport = ResealCounts & {
  ids: { unreadable: string[]; conflict: string[]; changed: string[] };
};

export type ResealOptions = Readonly<{
  /** The operator, written to the audit entries. */
  by: string;
  batchSize?: number | undefined;
  /** Runs after a batch is sealed and before its write; tests change rows here. */
  beforeWrite?: ((ids: readonly string[]) => Promise<void>) | undefined;
  /** Runs after each batch's write; tests stop a run here. */
  afterBatch?: (() => Promise<void>) | undefined;
}>;

/**
 * `reward_code` has FORCE row-level security and no policy for the owner, so only a superuser or a BYPASSRLS role
 * sees its rows; anything else would walk an empty table and report success.
 *
 * @throws Error before any read or write when the connection cannot see every row.
 */
async function assertSeesEveryRow(owner: Client): Promise<void> {
  const { rows } = await owner.query<{ sees: boolean }>(
    "SELECT rolsuper OR rolbypassrls AS sees FROM pg_roles WHERE rolname = current_user",
  );
  if (rows[0]?.sees !== true) {
    throw new Error(
      "This connection cannot read reward_code (row-level security is forced); run with DATABASE_ADMIN_URL, the owner.",
    );
  }
}

/** Walks `reward_code` by id, `size` rows at a time, outside any transaction. */
async function* codeBatches(owner: Client, size: number): AsyncGenerator<CodeRow[]> {
  let after = "0";
  for (;;) {
    const { rows } = await owner.query<CodeRow>(
      `SELECT id::text, reward_id::text, event_id::text, code_cipher FROM reward_code
        WHERE id > $1::bigint ORDER BY id LIMIT $2`,
      [after, size],
    );
    if (rows.length === 0) {
      return;
    }
    yield rows;
    after = rows[rows.length - 1]?.id ?? after;
  }
}

function emptyReport(): ResealReport {
  return {
    current: 0,
    resealed: 0,
    unreadable: 0,
    conflict: 0,
    changed: 0,
    ids: { unreadable: [], conflict: [], changed: [] },
  };
}

function note(report: ResealReport, kind: "unreadable" | "conflict" | "changed", id: string): void {
  report[kind] += 1;
  if (report.ids[kind].length < LISTED_IDS) {
    report.ids[kind].push(id);
  }
}

/** Opens each row; plans a fresh seal (new IV) and mark under the current key for those not current yet. */
function plan(ring: RewardCodeKeyring, rows: readonly CodeRow[], report: ResealReport): Planned[] {
  const planned: Planned[] = [];
  for (const row of rows) {
    const opened = openCode(ring, row.reward_id, row.code_cipher);
    if (opened === undefined) {
      note(report, "unreadable", row.id);
    } else if (isCurrent(ring, opened)) {
      report.current += 1;
    } else {
      planned.push({
        id: row.id,
        eventId: row.event_id,
        old: row.code_cipher,
        cipher: sealCode(ring, row.reward_id, opened.code),
        mark: markCode(ring.current, opened.code),
      });
    }
  }
  return planned;
}

/**
 * One row's compare-and-set: written only while its cipher is still the one read and no other row of the event holds
 * the new mark. The unique index stays the backstop; its error's detail holds the mark, so only the SQLSTATE is used.
 */
async function writeOne(owner: Client, item: Planned): Promise<Outcome> {
  await owner.query("SAVEPOINT reseal_row");
  try {
    const updated = await owner.query(
      `UPDATE reward_code c SET code_cipher = $2, code_hash = $3
        WHERE c.id = $1::bigint AND c.code_cipher = $4
          AND NOT EXISTS (SELECT 1 FROM reward_code o
                           WHERE o.event_id = c.event_id AND o.code_hash = $3 AND o.id <> c.id)`,
      [item.id, item.cipher, item.mark, item.old],
    );
    let outcome: Outcome = "resealed";
    if (updated.rowCount !== 1) {
      const { rows } = await owner.query<{ taken: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM reward_code o
                         WHERE o.event_id = $2::uuid AND o.code_hash = $3 AND o.id <> $1::bigint) AS taken`,
        [item.id, item.eventId, item.mark],
      );
      outcome = rows[0]?.taken === true ? "conflict" : "changed";
    }
    await owner.query("RELEASE SAVEPOINT reseal_row");
    return outcome;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== UNIQUE_VIOLATION && code !== LOCK_NOT_AVAILABLE) {
      // oxlint-disable-next-line preserve-caught-error -- a database error's detail can hold the new mark; only its SQLSTATE leaves
      throw new Error(
        `The re-seal stopped at reward_code ${item.id} (SQLSTATE ${String(code)}); run it again.`,
      );
    }
    await owner.query("ROLLBACK TO SAVEPOINT reseal_row");
    return code === UNIQUE_VIOLATION ? "conflict" : "changed";
  }
}

/**
 * A batch's writes: one transaction that only updates, waiting at most 2 seconds for any row lock. Its outcomes are
 * counted only once it commits, so a stopped run never reports a write it rolled back.
 */
async function writeBatch(
  owner: Client,
  planned: readonly Planned[],
  report: ResealReport,
): Promise<void> {
  await owner.query("BEGIN");
  try {
    await owner.query("SET LOCAL lock_timeout = '2s'");
    const outcomes: Outcome[] = [];
    for (const item of planned) {
      outcomes.push(await writeOne(owner, item));
    }
    await owner.query("COMMIT");
    planned.forEach((item, at) => {
      const outcome = outcomes[at];
      if (outcome === "resealed") {
        report.resealed += 1;
      } else if (outcome !== undefined) {
        note(report, outcome, item.id);
      }
    });
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

async function walk(
  owner: Client,
  ring: RewardCodeKeyring,
  options: ResealOptions,
  report: ResealReport,
): Promise<void> {
  for await (const rows of codeBatches(owner, options.batchSize ?? RESEAL_BATCH)) {
    const planned = plan(ring, rows, report);
    await options.beforeWrite?.(planned.map((item) => item.id));
    if (planned.length > 0) {
      await writeBatch(owner, planned, report);
    }
    await options.afterBatch?.();
  }
}

const countsOf = (report: ResealReport): ResealCounts => ({
  current: report.current,
  resealed: report.resealed,
  unreadable: report.unreadable,
  conflict: report.conflict,
  changed: report.changed,
});

/**
 * Seals every reward code again under the ring's current key (ADR-705, ADR-728), on the owner connection: used codes
 * too, so a player's redemption list keeps showing them. Idempotent and resumable: rows already current are skipped,
 * and a stopped run is simply run again. Audited twice, counts only: a start entry before the walk and the counts
 * entry when it ends, also when it fails, so a crashed run leaves a trail.
 *
 * @throws Error before any write when the connection cannot see every row, or naming the row id and SQLSTATE when a
 *   write fails for another reason than a conflict or a busy row.
 */
export async function resealCodes(
  owner: Client,
  ring: RewardCodeKeyring,
  options: ResealOptions,
): Promise<ResealReport> {
  await assertSeesEveryRow(owner);
  const base = { keyId: ring.current.id, by: options.by };
  await recordAudit(owner, {
    actor: { type: "system" },
    action: "reward.codes.reseal_start",
    target: { type: "reward_code" },
    after: base,
  });
  const report = emptyReport();
  const finish = (finished: boolean) =>
    recordAudit(owner, {
      actor: { type: "system" },
      action: "reward.codes.reseal",
      target: { type: "reward_code" },
      after: { ...base, ...countsOf(report), finished },
    });
  try {
    await walk(owner, ring, options, report);
  } catch (error) {
    await finish(false).catch((auditError: unknown) => {
      throw new AggregateError(
        [error, auditError],
        "The re-seal stopped and its audit entry failed.",
        { cause: error },
      );
    });
    throw error;
  }
  await finish(true);
  return report;
}

/** What `check` found: rows sealed under the current key in the new format, and the ids of the rest. */
export type CheckReport = { current: number; stale: number; ids: string[] };

/**
 * Proves the previous secret can go (ADR-728): walks every row with only the current key loaded, without writing.
 *
 * @throws Error before any read when the connection cannot see every row.
 */
export async function checkCodes(owner: Client, ring: RewardCodeKeyring): Promise<CheckReport> {
  await assertSeesEveryRow(owner);
  const only: RewardCodeKeyring = {
    current: ring.current,
    previous: undefined,
    keys: new Map([[ring.current.id, ring.current]]),
  };
  const report: CheckReport = { current: 0, stale: 0, ids: [] };
  for await (const rows of codeBatches(owner, RESEAL_BATCH)) {
    for (const row of rows) {
      const opened = openCode(only, row.reward_id, row.code_cipher);
      if (opened !== undefined && isCurrent(only, opened)) {
        report.current += 1;
      } else {
        report.stale += 1;
        if (report.ids.length < LISTED_IDS) {
          report.ids.push(row.id);
        }
      }
    }
  }
  return report;
}
