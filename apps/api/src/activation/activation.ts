import { isGatedFeature, type Registries } from "@questify/shared";

/** How an event's player count is held (FR-1021, ADR-076): not at all, warned at 80% and 100%, or a wall. */
export type LimitMode = "none" | "soft" | "hard";
export type PlayerLimit = Readonly<{ mode: LimitMode; value: number | null }>;

/** The largest limit the database accepts (event.player_limit CHECK, migration 0027). */
export const MAX_PLAYER_LIMIT = 1_000_000;

/**
 * A limit as the console sends it: `none` carries no number; `soft` and `hard` carry a whole number from 1 to
 * {@link MAX_PLAYER_LIMIT}. Undefined when the pair is not one of these.
 */
export function checkLimit(
  input: Readonly<{ mode: LimitMode; value?: number | null | undefined }>,
): PlayerLimit | undefined {
  const value = input.value ?? null;
  if (input.mode === "none") {
    return value === null ? { mode: "none", value: null } : undefined;
  }
  // Stryker disable next-line ConditionalExpression: equivalent: Number.isInteger(null) is false too
  if (value === null || !Number.isInteger(value) || value < 1 || value > MAX_PLAYER_LIMIT) {
    return undefined;
  }
  return { mode: input.mode, value };
}

export type AddonCheck =
  | Readonly<{ ok: true; addons: readonly string[] }>
  | Readonly<{ ok: false; unknown: string }>;

/** The add-ons an admin picked, each a gated feature of the app (FR-1729), without repeats, sorted. */
export function checkAddons(list: readonly string[], registries: Registries): AddonCheck {
  for (const feature of list) {
    if (!isGatedFeature(registries, feature)) {
      return { ok: false, unknown: feature };
    }
  }
  return { ok: true, addons: [...new Set(list)].toSorted() };
}

/** The database's answer when a hard limit is full (the enrollment trigger, migration 0027). */
export const EVENT_FULL = "QL409";

/** True when a database error is the hard limit refusing a seat, on any path that writes an enrollment. */
export function isEventFull(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === EVENT_FULL;
}

/** Why a definer refused, by its SQLSTATE (migration 0027). */
export type Refusal =
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "invalid"; field: "times" | "venue" }>;

const REFUSALS: Readonly<Record<string, (detail: string) => Refusal>> = {
  QE403: () => ({ kind: "forbidden" }),
  QA404: () => ({ kind: "not_found" }),
  QE409: () => ({ kind: "conflict" }),
  QA409: () => ({ kind: "conflict" }),
  QA422: (detail) => ({ kind: "invalid", field: detail === "venue" ? "venue" : "times" }),
};

/** The refusal a database error stands for, or undefined when it is not one of ours (then it is rethrown). */
export function refusalOf(error: unknown): Refusal | undefined {
  const pg = error as { code?: unknown; detail?: unknown } | null;
  const code = typeof pg?.code === "string" ? pg.code : undefined;
  // Stryker disable next-line ConditionalExpression: equivalent: no refusal is keyed "undefined"
  const make = code !== undefined && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
  // Stryker disable next-line ConditionalExpression,OptionalChaining,StringLiteral: equivalent: a missing detail and "" both read as "times", and make is undefined when pg is null
  return make?.(typeof pg?.detail === "string" ? pg.detail : "");
}

export type ActivationState = "not_requested" | "requested" | "rejected" | "activated";

/** Where an event stands: any status past draft is activated; a draft by its request, if any. */
export function activationStateOf(
  status: string,
  request: Readonly<{ state: "pending" | "rejected" }> | undefined,
): ActivationState {
  if (status !== "draft") {
    return "activated";
  }
  if (request === undefined) {
    return "not_requested";
  }
  return request.state === "pending" ? "requested" : "rejected";
}
