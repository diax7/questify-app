import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { registerConsoleOrganizerRoutes } from "#src/console/routes";
import type { SuspendedSet } from "#src/events/suspended-set";
import { HttpError } from "#src/http-error";

const ID = "11111111-1111-4111-8111-111111111111";

/** The console routes mounted without the console hook, so no request carries a signed-in staff member. */
function unguardedConsole() {
  const touched: string[] = [];
  const refuse = (what: string) => () => {
    touched.push(what);
    throw new Error(`${what} must not be reached without an admin`);
  };
  const app = Fastify();
  app.setErrorHandler((error: unknown, _request, reply) =>
    reply.code(error instanceof HttpError ? error.status : 500).send({ error: String(error) }),
  );
  registerConsoleOrganizerRoutes(app, {
    pool: { query: refuse("pool"), connect: refuse("pool") } as unknown as Pool,
    keys: { userKey: refuse("keys") },
    suspended: { has: refuse("suspended"), invalidate: refuse("suspended") } as SuspendedSet,
  });
  return { app, touched };
}

describe("the console organizer routes without a signed-in admin", () => {
  it("answer 404 before touching the database, the limits or the cache", async () => {
    const { app, touched } = unguardedConsole();
    const reason = { reason: "Reported fraud at the prize desk" };
    const requests = [
      { method: "GET", url: "/organizers" },
      { method: "GET", url: `/organizers/${ID}` },
      { method: "POST", url: `/organizers/${ID}/suspend`, payload: reason },
      { method: "POST", url: `/organizers/${ID}/reactivate`, payload: {} },
      { method: "POST", url: `/events/${ID}/suspend`, payload: reason },
      { method: "POST", url: `/events/${ID}/reactivate`, payload: {} },
      { method: "POST", url: `/events/${ID}/support`, payload: { kind: "view", ...reason } },
      { method: "POST", url: `/support/${ID}/close`, payload: {} },
    ] as const;
    for (const request of requests) {
      const answer = await app.inject(request);
      expect(answer.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
    expect(touched).toEqual([]);
    await app.close();
  });
});
