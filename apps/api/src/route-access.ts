import type { FastifyInstance } from "fastify";

/**
 * Who may call a route. Every route must say so in `config.access`; a route without it stops the server from
 * starting, so nothing becomes public by being forgotten. Later tasks add their kinds here (signed provider callback),
 * each with the hook that enforces it. `device` is a paired station, kiosk or big screen (T-309, devices/guard.ts).
 */
export const ACCESS_KINDS = [
  "public",
  "staff",
  "member",
  "owner",
  "player",
  "admin",
  "device",
] as const;
export type Access = (typeof ACCESS_KINDS)[number];

/** Each access kind is enforced by a hook on its own path; a label alone would protect nothing. */
const STAFF_PREFIX = "/v1/staff/";
/** `admin` routes live here, where the console hook checks for an active platform admin (activation/routes.ts). */
export const ADMIN_PREFIX = "/v1/admin/";
/** `member` and `owner` routes live here, where the organizer hook checks the membership (organizers/routes.ts). */
export const ORGANIZER_PREFIX = "/v1/organizers/:organizerId";

export type RouteInfo = Readonly<{ method: string; url: string; access: Access }>;

/** The decorator `registerPlayerGuard` sets, so a player route registered without the guard stops the server. */
export const PLAYER_GUARD = "playerGuard";
/** The decorator `registerDeviceGuard` sets (T-309), so a device route registered without the guard stops the server. */
export const DEVICE_GUARD = "deviceGuard";
/** `device` routes live here and only here (CTO 5): `/v1/devices` is not a device route. */
export const isDevicePath = (url: string): boolean =>
  url === "/v1/device" || url.startsWith("/v1/device/");

const isAccess = (value: unknown): value is Access =>
  typeof value === "string" && (ACCESS_KINDS as readonly string[]).includes(value);

/** What a route rule judges, once the route's access kind is known. */
export type RouteFacts = Readonly<{
  name: string;
  url: string;
  access: Access;
  idempotent: boolean;
  hasDecorator: (decorator: string) => boolean;
}>;

const isOrganizerPath = (url: string): boolean =>
  url === ORGANIZER_PREFIX || url.startsWith(`${ORGANIZER_PREFIX}/`);

/**
 * The rules every route with a known access kind must keep, in the order they are judged; each answers its refusal or
 * undefined. Every rule is asked until one refuses: none lets a route through early.
 */
const ROUTE_RULES: ReadonlyArray<(route: RouteFacts) => string | undefined> = [
  ({ name, url, access }) =>
    access === "staff" && !url.startsWith(STAFF_PREFIX)
      ? `Route ${name} is marked staff but is outside ${STAFF_PREFIX}, where the session check runs.`
      : undefined,
  ({ name, url, access }) =>
    (access === "member" || access === "owner") !== isOrganizerPath(url)
      ? `Route ${name}: member and owner routes, and only they, live under ${ORGANIZER_PREFIX}, where the membership check runs.`
      : undefined,
  ({ name, url, access }) =>
    (access === "admin") !== url.startsWith(ADMIN_PREFIX)
      ? `Route ${name}: admin routes, and only they, live under ${ADMIN_PREFIX}, where the platform admin check runs.`
      : undefined,
  // A player route has no path of its own: the bearer check is one hook on every route marked `player`.
  ({ name, access, hasDecorator }) =>
    access === "player" && !hasDecorator(PLAYER_GUARD)
      ? `Route ${name} is marked player but the player guard is not registered before it.`
      : undefined,
  ({ name, url, access }) =>
    access === "device" && !isDevicePath(url)
      ? `Route ${name} is marked device but is outside /v1/device, where the device check runs.`
      : undefined,
  ({ name, access, hasDecorator }) =>
    access === "device" && !hasDecorator(DEVICE_GUARD)
      ? `Route ${name} is marked device but the device guard is not registered before it.`
      : undefined,
  ({ name, access, idempotent }) =>
    access === "public" && idempotent
      ? `Route ${name} is public, so it cannot take idempotency keys.`
      : undefined,
];

/** The first rule a route breaks, or undefined when it keeps them all. Exported for its test. */
export function routeRefusal(route: RouteFacts): string | undefined {
  for (const rule of ROUTE_RULES) {
    const refusal = rule(route);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}

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
      const refusal = routeRefusal({
        name,
        url: route.url,
        access,
        idempotent: route.config?.idempotent === true,
        // The root server's decorators, as before: never the hook's `this`.
        hasDecorator: (decorator) => app.hasDecorator(decorator),
      });
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
      inventory.push({ method, url: route.url, access });
    }
  });
  return inventory;
}
