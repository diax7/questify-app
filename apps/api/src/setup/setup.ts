import {
  SETUP_STEP_COUNT,
  type SetupProgress,
  type SetupRead,
  type SetupStepState,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";

export type SetupDeps = Readonly<{ pool: Pool }>;

/** The progress with the time it was last saved; null when the event's setup was never opened. */
export type SetupState = SetupRead["setup"];

const LETTER: Readonly<Record<SetupStepState, string>> = { open: "n", done: "d", skipped: "s" };
const STATE_OF: Readonly<Record<string, SetupStepState>> = {
  n: "open",
  d: "done",
  s: "skipped",
};

/** The ten states as the column holds them: one letter each, in step order (migration 0100). */
export const encodeSteps = (steps: readonly SetupStepState[]): string =>
  steps.map((state) => LETTER[state]).join("");

/** The column's letters as states; any letter the column's check refuses cannot be stored, so none is unknown. */
export const decodeSteps = (text: string): SetupStepState[] =>
  Array.from(text, (letter) => STATE_OF[letter] ?? "open");

/** What an event shows before its first save: step 1, nothing decided. */
const FRESH: SetupState = {
  currentStep: 1,
  steps: Array.from({ length: SETUP_STEP_COUNT }, () => "open" as const),
  finished: false,
  updatedAt: null,
};

type Row = { current_step: number; steps: string; finished: boolean; updated_at: Date };

const stateOf = (row: Row): SetupState => ({
  currentStep: row.current_step,
  steps: decodeSteps(row.steps),
  finished: row.finished,
  updatedAt: row.updated_at.toISOString(),
});

/** Runs `work` as the caller on an event they can reach; undefined when the event is outside their reach. */
async function onEvent<T>(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T | undefined> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async () => {
        const { rows } = await client.query(
          "SELECT 1 FROM event WHERE organizer_id = $1 AND id = $2",
          [actor.organizerId, eventId],
        );
        return rows.length === 0 ? undefined : work(client);
      },
    ),
  );
}

/** Where the event's guided setup stands (FR-1754); a fresh start when it was never saved. */
export function readSetup(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
): Promise<SetupState | undefined> {
  return onEvent(deps, actor, eventId, async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT current_step, steps, finished_at IS NOT NULL AS finished, updated_at
       FROM event_setup WHERE event_id = $1`,
      [eventId],
    );
    const row = rows[0];
    return row === undefined ? FRESH : stateOf(row);
  });
}

/**
 * Saves the progress as given, replacing what was saved (the last save wins, FR-1754). Saving the same progress twice
 * gives the same state. `finished_at` keeps the time of the first finish while the progress stays finished.
 */
export function saveSetup(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  progress: SetupProgress,
): Promise<SetupState | undefined> {
  return onEvent(deps, actor, eventId, async (client) => {
    const { rows } = await client.query<Row>(
      `INSERT INTO event_setup (event_id, organizer_id, current_step, steps, finished_at, updated_by)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END, $6)
       ON CONFLICT (event_id) DO UPDATE SET
         current_step = EXCLUDED.current_step,
         steps = EXCLUDED.steps,
         finished_at = CASE WHEN $5::boolean THEN coalesce(event_setup.finished_at, now()) END,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING current_step, steps, finished_at IS NOT NULL AS finished, updated_at`,
      [
        eventId,
        actor.organizerId,
        progress.currentStep,
        encodeSteps(progress.steps),
        progress.finished,
        actor.staffUserId,
      ],
    );
    return stateOf(rows[0] as Row);
  });
}
