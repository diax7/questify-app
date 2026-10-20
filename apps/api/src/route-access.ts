import type { FastifyInstance } from "fastify";

/**
 * Who may call a route. Every route must say so in `config.access`; a route without it stops the server from
 * starting, so nothing becomes public by being forgotten. Later tasks add their kinds here (player bearer token,
 * screen token, signed provider callback), each with the hook that enforces it.
 */
export const ACCESS_KINDS = ["public", "staff", "member", "owner", "player"] as const;
export type Access = (typeof ACCESS_KINDS)[number];

/** Each access kind is enforced by a hook on its own path; a label alone would protect nothing. */
const STAFF_PREFIX = "/v1/staff/";
/** `member` and `owner` routes live here, where the organizer hook checks the membership (organizers/routes.ts). */
export const ORGANIZER_PREFIX = "/v1/organizers/:organizerId";

export type RouteInfo = Readonly<{ method: string; url: string; access: Access }>;

/** The decorator `registerPlayerGuard` sets, so a player route registered without the guard stops the server. */
export const PLAYER_GUARD = "playerGuard";

const isAccess = (value: unknown): value is Access =>
  typeof value === "string" && (ACCESS_KINDS as readonly string[]).includes(value);

/**
 * Records every route with its access kind and refuses a route that has none. Register it before any route.
 * An idempotent route must have a principal: the anonymous key space is shared, so one caller could replay
 * another caller's stored answer.
 *
 * @throws Error naming the route when its access is missing or unknown, or when it is public and idempotent.
 */
export function registerRouteInventory(app: FastifyInstance): RouteInfo[] {
  const inventory: RouteInfo[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const access: unknown = route.config?.access;
    for (const method of methods) {
      const name = `${method} ${route.url}`;
      if (!isAccess(access)) {
        throw new Error(
          `Route ${name} must declare config.access (one of ${ACCESS_KINDS.join(", ")}).`,
        );
      }
      if (access === "staff" && !route.url.startsWith(STAFF_PREFIX)) {
        throw new Error(
          `Route ${name} is marked staff but is outside ${STAFF_PREFIX}, where the session check runs.`,
        );
      }
      const organizerRoute =
        route.url === ORGANIZER_PREFIX || route.url.startsWith(`${ORGANIZER_PREFIX}/`);
      if ((access === "member" || access === "owner") !== organizerRoute) {
        throw new Error(
          `Route ${name}: member and owner routes, and only they, live under ${ORGANIZER_PREFIX}, where the membership check runs.`,
        );
      }
      // A player route has no path of its own: the bearer check is one hook on every route marked `player`.
      if (access === "player" && !app.hasDecorator(PLAYER_GUARD)) {
        throw new Error(
          `Route ${name} is marked player but the player guard is not registered before it.`,
        );
      }
      if (access === "public" && route.config?.idempotent === true) {
        throw new Error(`Route ${name} is public, so it cannot take idempotency keys.`);
      }
      inventory.push({ method, url: route.url, access });
    }
  });
  return inventory;
}
