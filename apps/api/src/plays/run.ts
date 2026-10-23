import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";

export type PlayDeps = Readonly<{ pool: Pool }>;

/** Why a vote or a quiz step was refused; each maps to one HTTP answer in the routes. */
export type PlayRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "quest_not_open"; reason: string }>
  | Readonly<{ kind: "operator_not_playing" }>
  | Readonly<{ kind: "not_vote_quest" }>
  | Readonly<{ kind: "not_quiz_quest" }>
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

/** The SQLSTATEs of migration 0041's definers (and record_completion under vote_quest). */
const REFUSALS: Readonly<Record<string, (detail: string) => PlayRefusal | undefined>> = {
  QC404: () => ({ kind: "not_found" }),
  AQ404: () => ({ kind: "not_found" }),
  AN404: () => ({ kind: "not_found" }),
  QC403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  QN403: (detail) => ({ kind: "quest_not_open", reason: detail }),
  QP403: () => ({ kind: "operator_not_playing" }),
  QT422: (detail) => ({ kind: detail === "vote" ? "not_vote_quest" : "not_quiz_quest" }),
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
