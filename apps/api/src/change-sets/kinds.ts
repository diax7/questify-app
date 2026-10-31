import type { ApiErrorEnvelope } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import type { Caller } from "#src/auth/sign-in";
import type { JsonObject, ItemOp } from "#src/change-sets/store";
import type { Actor } from "#src/events/events";
import { HttpError } from "#src/http-error";
import type { Bilingual, BuilderEvent } from "#src/quests/store";
import type { RewardCodeKey } from "#src/rewards/codes";
import type { SettingsService } from "#src/settings/service";

/** What an item's operation runs on: the builder's own services, with the caller's seat. */
export type RunContext = Readonly<{
  pool: Pool;
  codeKey: RewardCodeKey;
  settings: Pick<SettingsService, "forEvent">;
  actor: Actor;
  caller: Caller;
  eventId: string;
}>;

/** A target as it is now: the view the audit log keeps of it, its name, and the record the kind reads back. */
export type Seen = Readonly<{ view: JsonObject; name: Bilingual; record: unknown }>;

export type Parsed =
  | Readonly<{ ok: true; input: unknown }>
  | Readonly<{ ok: false; field: string }>;

/** What an item would leave behind: the target's view after it (null for a delete), or why it would be refused. */
export type After =
  | Readonly<{ ok: true; view: JsonObject | null; name: Bilingual }>
  | Readonly<{ ok: false; problem: ApiErrorEnvelope }>;

export type Reader = Readonly<{ client: PoolClient; event: BuilderEvent }>;

/**
 * One kind of target (quest, category or reward): how to read it, check a body, say what an item would leave, and run
 * it through the builder's service. Nothing here writes except `run`, and `run` calls the service the route calls.
 */
export type TargetKind = Readonly<{
  /** The refusal for a body that fails the route's schema; `field` is the first field that failed. */
  invalid: (field: string) => ApiErrorEnvelope;
  read: (reader: Reader, id: string) => Promise<Seen | undefined>;
  parse: (op: ItemOp, body: JsonObject) => Parsed;
  after: (reader: Reader, op: ItemOp, seen: Seen | undefined, input: unknown) => Promise<After>;
  run: (
    context: RunContext,
    item: Readonly<{ id: string; op: ItemOp; targetId: string | null }>,
    input: unknown,
  ) => Promise<ApiErrorEnvelope | null>;
}>;

/** A body checked against a route's schema: its input, or the first field that failed. */
export function parseWith(schema: z.ZodType, body: JsonObject): Parsed {
  const result = schema.safeParse(body);
  if (result.success) {
    return { ok: true, input: result.data };
  }
  const field = result.error.issues[0]?.path[0];
  return { ok: false, field: typeof field === "string" ? field : "body" };
}

/** The error envelope a route would answer if `answer` throws, or null when it returns. */
export function envelopeOf(answer: () => unknown): ApiErrorEnvelope | null {
  try {
    answer();
    return null;
  } catch (error) {
    if (error instanceof HttpError) {
      return error.envelope;
    }
    throw error;
  }
}
