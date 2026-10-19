import type { FastifyInstance } from "fastify";

/**
 * Who may call a route. Every route must say so in `config.access`; a route without it stops the server from
 * starting, so nothing becomes public by being forgotten. Later tasks add their kinds here (player bearer token,
 * screen token, signed provider callback), each with the hook that enforces it.
 */
export const ACCESS_KINDS = ["public", "staff"] as const;
export type Access = (typeof ACCESS_KINDS)[number];

export type RouteInfo = Readonly<{ method: string; url: string; access: Access }>;

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
      if (access === "public" && route.config?.idempotent === true) {
        throw new Error(`Route ${name} is public, so it cannot take idempotency keys.`);
      }
      inventory.push({ method, url: route.url, access });
    }
  });
  return inventory;
}
