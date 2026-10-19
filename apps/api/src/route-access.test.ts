import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ACCESS_KINDS, registerRouteInventory } from "#src/route-access";

const build = () => {
  const app = Fastify();
  const inventory = registerRouteInventory(app);
  return { app, inventory };
};

describe("registerRouteInventory", () => {
  it("records each route with its access kind, including the automatic HEAD route", async () => {
    const { app, inventory } = build();
    app.get("/a", { config: { access: "public" } }, async () => ({}));
    app.post("/v1/staff/b", { config: { access: "staff" } }, async () => ({}));
    await app.ready();
    expect(inventory).toEqual([
      { method: "GET", url: "/a", access: "public" },
      { method: "HEAD", url: "/a", access: "public" },
      { method: "POST", url: "/v1/staff/b", access: "staff" },
    ]);
    await app.close();
  });

  it("stops the server from starting when a route does not say who may call it", async () => {
    const { app } = build();
    expect(() => app.get("/forgotten", async () => ({}))).toThrow(
      "Route GET /forgotten must declare config.access (one of public, staff).",
    );
  });

  it("refuses an access kind it does not know", () => {
    const { app } = build();
    expect(() =>
      app.get("/odd", { config: { access: "everyone" as never } }, async () => ({})),
    ).toThrow(/must declare config.access/);
  });

  it("refuses a public route that takes idempotency keys, because anonymous keys are shared", () => {
    const { app } = build();
    expect(() =>
      app.post("/pay", { config: { access: "public", idempotent: true } }, async () => ({})),
    ).toThrow("Route POST /pay is public, so it cannot take idempotency keys.");
  });

  it("allows an idempotent route that has a principal", async () => {
    const { app, inventory } = build();
    app.post("/v1/staff/pay", { config: { access: "staff", idempotent: true } }, async () => ({}));
    await app.ready();
    expect(inventory).toEqual([{ method: "POST", url: "/v1/staff/pay", access: "staff" }]);
    await app.close();
  });

  it("refuses a staff label on a route outside /v1/staff, where no session check would run", () => {
    const { app } = build();
    expect(() => app.get("/me", { config: { access: "staff" } }, async () => ({}))).toThrow(
      "Route GET /me is marked staff but is outside /v1/staff/, where the session check runs.",
    );
  });

  it("lists the known kinds", () => {
    expect(ACCESS_KINDS).toEqual(["public", "staff"]);
  });
});
