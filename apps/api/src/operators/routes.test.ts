import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  registerOperatorPlayerRoutes,
  registerOperatorRoutes,
  type OperatorPlayerDeps,
} from "#src/operators/routes";

type Registered = Readonly<{ method: string; url: string; config: unknown; bodyLimit: unknown }>;

/** Every route a register function adds, in registration order, with its guard config and body limit. */
async function registered(register: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify({ exposeHeadRoutes: false });
  const routes: Registered[] = [];
  app.addHook("onRoute", (route) => {
    routes.push({
      method: [route.method].flat().join(","),
      url: route.url,
      config: route.config,
      bodyLimit: route.bodyLimit,
    });
  });
  register(app);
  await app.ready();
  await app.close();
  return routes;
}

const member = { access: "member" };
const owner = { access: "owner" };

describe("the operator routes", () => {
  it("registers the owner's routes, in this order, with these guards", async () => {
    const routes = await registered((app) => registerOperatorRoutes(app, {} as never));
    expect(routes).toEqual([
      { method: "GET", url: "/events/:eventId/operators", config: member, bodyLimit: 4096 },
      {
        method: "POST",
        url: "/events/:eventId/operators/invites",
        config: { access: "owner", idempotent: true },
        bodyLimit: 4096,
      },
      {
        method: "DELETE",
        url: "/events/:eventId/operators/invites/:inviteId",
        config: owner,
        bodyLimit: 4096,
      },
      {
        method: "PUT",
        url: "/events/:eventId/operators/:operatorId",
        config: owner,
        bodyLimit: 4096,
      },
      {
        method: "DELETE",
        url: "/events/:eventId/operators/:operatorId",
        config: owner,
        bodyLimit: 4096,
      },
    ]);
  });

  it("registers the person's routes, in this order, with these guards", async () => {
    const routes = await registered((app) =>
      registerOperatorPlayerRoutes(app, { pool: {}, myKey: {} } as unknown as OperatorPlayerDeps),
    );
    const plain = '{"access":"player"}';
    const idempotent = '{"access":"player","idempotent":true}';
    expect(
      routes.map((r) => `${r.method} ${r.url} ${JSON.stringify(r.config)} ${r.bodyLimit}`),
    ).toEqual([
      `POST /v1/operator-invites/preview ${plain} 1024`,
      `POST /v1/operator-invites/claim ${idempotent} 1024`,
      `GET /v1/me/operator-events ${plain} 1024`,
      `GET /v1/operator/events/:eventId/stations ${plain} 1024`,
      `POST /v1/events/:eventId/operator/play ${idempotent} 1024`,
      `GET /v1/me/qr ${plain} 1024`,
      `POST /v1/me/qr/reset ${idempotent} 1024`,
      `GET /v1/operator/events/:eventId/stations/:questId/today ${plain} 1024`,
      `POST /v1/operator/sessions/:sessionId/check-in ${plain} 1024`,
      `GET /v1/operator/events/:eventId/sessions ${plain} undefined`,
      `POST /v1/operator/scan/practice ${plain} 1024`,
      `POST /v1/operator/scan ${idempotent} 1024`,
    ]);
  });
});
