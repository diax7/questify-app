import type { Pool, PoolClient } from "pg";
import { bonusPaid, levelReached, type Bonus, type LevelUp } from "#src/completions/complete";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";

export type PlayDeps = Readonly<{ pool: Pool }>;

/** Why a vote, a quiz step, a survey or a share was refused; each maps to one HTTP answer in the routes. */
export type PlayRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "quest_not_open"; reason: string }>
  | Readonly<{ kind: "operator_not_playing" }>
  | Readonly<{ kind: "not_vote_quest" }>
  | Readonly<{ kind: "not_quiz_quest" }>
  | Readonly<{ kind: "not_survey_quest" }>
  | Readonly<{ kind: "not_share_quest" }>
  /** A survey answer the question does not take, or a body that names other questions (`shape`). */
  | Readonly<{ kind: "bad_answer"; question: string }>
  /** The event switched this quest type off (share quests, ADR-199). */
  | Readonly<{ kind: "feature_off" }>
  | Readonly<{ kind: "unknown_option" }>
  | Readonly<{ kind: "already_completed" }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "quiz_not_started" }>
  | Readonly<{ kind: "already_answered" }>
  | Readonly<{ kind: "question_closed" }>
  | Readonly<{ kind: "question_not_served" }>;

export type Done<T> = Readonly<{ kind: "done"; value: T }> | PlayRefusal;

const QA409: Readonly<Record<string, PlayRefusal>> = {
  answered: { kind: "already_answered" },
  closed: { kind: "question_closed" },
  not_served: { kind: "question_not_served" },
};

/** QT422's DETAIL names the type the call wanted. */
const NOT_THIS_TYPE: Readonly<Record<string, PlayRefusal>> = {
  vote: { kind: "not_vote_quest" },
  quiz: { kind: "not_quiz_quest" },
  survey: { kind: "not_survey_quest" },
  share: { kind: "not_share_quest" },
};

/** The SQLSTATEs of migrations 0041 and 0042's definers (and record_completion under vote_quest). */
const REFUSALS: Readonly<Record<string, (detail: string) => PlayRefusal | undefined>> = {
  QC404: () => ({ kind: "not_found" }),
  AQ404: () => ({ kind: "not_found" }),
  AN404: () => ({ kind: "not_found" }),
  QC403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  QN403: (detail) => ({ kind: "quest_not_open", reason: detail }),
  QP403: () => ({ kind: "operator_not_playing" }),
  QT422: (detail) => NOT_THIS_TYPE[detail],
  SA422: (detail) => ({ kind: "bad_answer", question: detail }),
  QF403: () => ({ kind: "feature_off" }),
  VO422: () => ({ kind: "unknown_option" }),
  QO422: () => ({ kind: "unknown_option" }),
  QD409: () => ({ kind: "already_completed" }),
  QK422: () => ({ kind: "key_reused" }),
  QA404: () => ({ kind: "quiz_not_started" }),
  QA409: (detail) => QA409[detail],
};

/** Runs one call in `context`; a refusal the database raises becomes its result, anything else is thrown. */
export async function run<T>(
  deps: PlayDeps,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<Done<T>> {
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, context, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code]?.(pg.detail ?? "");
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/** Organizer text in both languages, null where it was not written. */
export type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

export const textOf = (value: unknown): Bilingual => {
  const text = (value ?? {}) as { ar?: string; en?: string };
  return { ar: text.ar ?? null, en: text.en ?? null };
};

/** A play paid as an ordinary completion (a vote, a survey, a share): what the player sees after it. */
export type Paid = Readonly<{
  completionId: string;
  points: number;
  score: number;
  balance: number;
  replayed: boolean;
  levelUp: LevelUp | null;
  /** The category bonus this play paid (T-304), or null. */
  bonus: Bonus | null;
}>;

/** The row `vote_quest`, `submit_survey` and `share_quest` answer with. */
export type PaidRow = Readonly<{
  completion_id: string;
  points: string;
  score: string;
  balance: string;
  replayed: boolean;
}>;

/** The first row of a paying definer's answer, with the level its payment reached. */
export async function paidOf(client: PoolClient, rows: readonly PaidRow[]): Promise<Paid> {
  const row = rows[0] as PaidRow;
  return {
    completionId: row.completion_id,
    points: Number(row.points),
    score: Number(row.score),
    balance: Number(row.balance),
    replayed: row.replayed,
    levelUp: await levelReached(client, row.completion_id),
    bonus: await bonusPaid(client, row.completion_id),
  };
}
