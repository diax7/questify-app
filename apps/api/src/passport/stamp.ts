import type { Caller } from "#src/auth/sign-in";
import { paidOf, run, type Done, type Paid, type PaidRow, type PlayDeps } from "#src/plays/run";
import { verifyStepCode, type StepCodeKey } from "#src/quests/qr";

export type PassportDeps = PlayDeps & Readonly<{ stepKey: StepCodeKey }>;

export type StampRequest = Readonly<{
  playerId: string;
  stepId: string;
  /** The token the app read from the step's /q/{token} address. */
  code: string;
  idempotencyKey: string;
  /** The app's install id when it sent a well-formed one; a claim from an honest client only. */
  deviceId: string | undefined;
}>;

/** A stamp's answer (T-304b, FR-224): the passport's progress and, on the stamp that finished it, the payment. */
export type Stamped = Readonly<{
  questId: string;
  /** False when this step was stamped before: nothing was written. */
  stamped: boolean;
  done: number;
  needed: number;
  completed: Paid | null;
}>;

type StampRow = PaidRow &
  Readonly<{ quest_id: string; stamped: boolean; done: number; needed: number }>;

/**
 * Stamps a passport step for the calling player: the API checks the code's signature and that it is this step's;
 * `stamp_step` checks every other rule and pays the passport once, on the stamp that reaches its `needed` (ADR-203).
 */
export async function stampStep(
  deps: PassportDeps,
  request: StampRequest,
  caller: Caller,
): Promise<Done<Stamped>> {
  const check = verifyStepCode(deps.stepKey, request.code, request.stepId);
  if (check.kind !== "valid") {
    return refused(caller, request.stepId, { kind: "invalid_code", problem: check.kind });
  }
  const result = await run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<StampRow>("SELECT * FROM stamp_step($1, $2, $3, $4)", [
      request.stepId,
      check.version,
      request.idempotencyKey,
      request.deviceId ?? null,
    ]);
    const row = rows[0] as StampRow;
    return {
      questId: row.quest_id,
      stamped: row.stamped,
      done: row.done,
      needed: row.needed,
      completed: row.completion_id === null ? null : await paidOf(client, rows),
    };
  });
  if (result.kind !== "done") {
    return refused(caller, request.stepId, result);
  }
  caller.log("passport.stamped", {
    questId: result.value.questId,
    paid: String(result.value.completed !== null),
  });
  return result;
}

/** Logs a refusal with its reason (a spike of forged codes is worth a look, RUNBOOK); never the token. */
function refused<T extends Exclude<Done<unknown>, { kind: "done" }>>(
  caller: Caller,
  stepId: string,
  result: T,
): T {
  const reason =
    result.kind === "invalid_code"
      ? result.problem
      : result.kind === "quest_not_open" || result.kind === "enrollment_inactive"
        ? result.reason
        : result.kind;
  caller.log("passport.refused", { stepId, refusal: result.kind, reason });
  return result;
}

/** A passport the calling player may see: how many steps it needs and each step with whether they stamped it. */
export type PassportView = Readonly<{
  needed: number;
  steps: readonly Readonly<{
    id: string;
    name: Readonly<{ ar: string | null; en: string | null }>;
    done: boolean;
  }>[];
}>;

type PassportRow = Readonly<{
  needed: number;
  step_id: string;
  name_ar: string | null;
  name_en: string | null;
  done: boolean;
}>;

/** Not found for anything the player may not see: a stranger, a hidden passport, another type. */
export async function readPassport(
  deps: PlayDeps,
  playerId: string,
  questId: string,
): Promise<Done<PassportView>> {
  const result = await run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<PassportRow>("SELECT * FROM member_passport($1)", [
      questId,
    ]);
    return rows;
  });
  if (result.kind !== "done") {
    return result;
  }
  const first = result.value[0];
  if (first === undefined) {
    return { kind: "not_found" };
  }
  return {
    kind: "done",
    value: {
      needed: first.needed,
      steps: result.value.map((row) => ({
        id: row.step_id,
        name: { ar: row.name_ar, en: row.name_en },
        done: row.done,
      })),
    },
  };
}
