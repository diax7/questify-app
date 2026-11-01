import type { NameAudience, NameDisplay } from "@questify/shared";
import type { Caller } from "#src/auth/sign-in";
import type { Actor } from "#src/events/events";
import {
  audit,
  done,
  namesOf,
  readEvent,
  withSetupEvent,
  type NamesSettings,
  type SetupDeps,
  type SetupDone,
} from "#src/join/setup";

export type NamesInput = Readonly<{ display: NameDisplay; audience: NameAudience }>;

type PgError = Readonly<{ code?: string }>;

/**
 * Sets how the event names its players and who sees a full name (FR-1842, ADR-400), for its owner or an editor. The
 * database's guard decides the two refusals, so they hold for any writer: ND422, a full name needs the event's Full name
 * join field, and ND409, widening to everyone while a player who was not told is in the event. Narrowing is always
 * allowed. Audited as one entry with the setting before and after (never a name).
 */
export function updateNames(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  input: NamesInput,
  caller: Caller,
): Promise<SetupDone<NamesSettings>> {
  return withSetupEvent(deps, actor, eventId, async (client) => {
    const before = namesOf(await readEvent(client, eventId));
    await client.query("SAVEPOINT names");
    try {
      await client.query("UPDATE event SET name_display = $2, name_audience = $3 WHERE id = $1", [
        eventId,
        input.display,
        input.audience,
      ]);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT names");
      const code = (error as PgError).code;
      if (code === "ND409") {
        return { kind: "name_display_locked" };
      }
      if (code === "ND422") {
        return { kind: "needs_full_name_field" };
      }
      throw error;
    }
    const after = namesOf(await readEvent(client, eventId));
    await audit(client, actor, caller, {
      action: "event.names.update",
      eventId,
      before: { display: before.display, audience: before.audience },
      after: { display: after.display, audience: after.audience },
    });
    return done(after);
  });
}
