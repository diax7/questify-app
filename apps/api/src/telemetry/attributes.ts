import type { Attributes, AttributeValue } from "@opentelemetry/api";

/**
 * The background loops that report their runs (`trackRun`): the label of the loop metrics, and what the stalled-loop
 * alerts name.
 */
export const TICKS = [
  "lifecycle",
  "community",
  "souvenir",
  "invitation",
  "rank_push",
  "organizer_alerts",
  "team_alerts",
  "ranking_repair",
  "push_worker",
  "media",
] as const;
export type Tick = (typeof TICKS)[number];

export const ROUTE_CLASSES = ["completion", "other"] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

export const OPERATIONS = ["sms", "email", "push"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const POOLS = ["api", "push"] as const;
export type PoolName = (typeof POOLS)[number];

export const POOL_STATES = ["total", "idle", "waiting"] as const;
export type PoolState = (typeof POOL_STATES)[number];

type Rule = (value: AttributeValue) => boolean;

const matches =
  (pattern: RegExp): Rule =>
  (value) =>
    typeof value === "string" && pattern.test(value);

const oneOf =
  (list: readonly string[]): Rule =>
  (value) =>
    typeof value === "string" && list.includes(value);

const httpStatus: Rule = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;

/**
 * Every attribute a metric or a span may carry (ADR-603). The list is closed and each value has a shape: a method, a
 * route pattern (the registered pattern with parameter names, never the URL a caller sent), a status, a name from a
 * fixed list, or an event name written in the code. Nothing here can hold a username, an address, a number or a token,
 * because no key takes free text. A key not on the list, or a value not in its shape, is dropped.
 */
export const ATTRIBUTE_RULES: Readonly<Record<string, Rule>> = {
  "http.request.method": oneOf(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  "http.route": matches(/^(unmatched|\/[A-Za-z0-9_\-./:*{}]{0,159})$/),
  "http.response.status_code": httpStatus,
  "questify.route_class": oneOf(ROUTE_CLASSES),
  "questify.event": matches(/^(?=.{3,64}$)[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/),
  "questify.log.level": oneOf(["info", "warn", "error"]),
  "questify.operation": oneOf(OPERATIONS),
  "questify.provider": matches(/^[a-z][a-z0-9:_-]{1,31}$/),
  "questify.outcome": matches(/^[a-z][a-z_]{1,23}$/),
  "questify.tick": oneOf(TICKS),
  "questify.pool": oneOf(POOLS),
  "questify.pool.state": oneOf(POOL_STATES),
};

/** What the three resource attributes of every signal may be: the service, its build and its deployment. */
export const RESOURCE_KEYS = [
  "service.name",
  "service.version",
  "service.instance.id",
  "deployment.environment.name",
] as const;

/** The candidate attributes cut down to the allowed keys whose values have the right shape. */
export function safeAttributes(
  candidate: Readonly<Record<string, AttributeValue | undefined>>,
): Attributes {
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(candidate)) {
    const rule = ATTRIBUTE_RULES[key];
    if (value !== undefined && rule !== undefined && rule(value)) {
      kept[key] = value;
    }
  }
  return kept;
}
