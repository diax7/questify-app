import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  ACCESS_KINDS,
  DEVICE_GUARD,
  PLAYER_GUARD,
  registerRouteInventory,
  routeRefusal,
  type Access,
} from "#src/route-access";

const build = () => {
  const app = Fastify();
  const inventory = registerRouteInventory(app);
  return { app, inventory };
};

const message = (url: string): string =>
  `Route GET ${url}: member and owner routes, and only they, live under /v1/organizers/:organizerId, where the membership check runs.`;

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
      "Route GET /forgotten must declare config.access (one of public, staff, member, owner, player, admin, device).",
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

  it("refuses a player route until the player guard is registered, and takes it after", async () => {
    const { app, inventory } = build();
    expect(() =>
      app.post("/v1/quests/:id/complete", { config: { access: "player" } }, async () => ({})),
    ).toThrow(
      "Route POST /v1/quests/:id/complete is marked player but the player guard is not registered before it.",
    );
    app.decorate(PLAYER_GUARD, true);
    app.post(
      "/v1/quests/:id/complete",
      { config: { access: "player", idempotent: true } },
      async () => ({}),
    );
    await app.ready();
    expect(inventory).toEqual([
      { method: "POST", url: "/v1/quests/:id/complete", access: "player" },
    ]);
    await app.close();
  });

  it("takes device routes only under /v1/device, and only once the device guard is registered (T-309)", async () => {
    const { app, inventory } = build();
    expect(() => app.get("/v1/device", { config: { access: "device" } }, async () => ({}))).toThrow(
      "Route GET /v1/device is marked device but the device guard is not registered before it.",
    );
    app.decorate(DEVICE_GUARD, true);
    for (const url of ["/v1/devices", "/v1/devicex/a", "/v1/staff/device", "/device"]) {
      expect(() => app.get(url, { config: { access: "device" } }, async () => ({}))).toThrow(
        `Route GET ${url} is marked device but is outside /v1/device, where the device check runs.`,
      );
    }
    app.get("/v1/device", { config: { access: "device" } }, async () => ({}));
    app.post("/v1/device/activate", { config: { access: "device" } }, async () => ({}));
    await app.ready();
    expect(inventory.filter((route) => route.method !== "HEAD")).toEqual([
      { method: "GET", url: "/v1/device", access: "device" },
      { method: "POST", url: "/v1/device/activate", access: "device" },
    ]);
    await app.close();
  });

  it("refuses a staff label on a route outside /v1/staff, where no session check would run", () => {
    const { app } = build();
    expect(() => app.get("/me", { config: { access: "staff" } }, async () => ({}))).toThrow(
      "Route GET /me is marked staff but is outside /v1/staff/, where the session check runs.",
    );
  });

  it("keeps member and owner routes under /v1/organizers/:organizerId, and nothing else there", async () => {
    const { app, inventory } = build();
    app.get(
      "/v1/organizers/:organizerId/members",
      { config: { access: "member" } },
      async () => ({}),
    );
    app.post(
      "/v1/organizers/:organizerId/invites",
      { config: { access: "owner" } },
      async () => ({}),
    );
    await app.ready();
    expect(inventory.filter((route) => route.method !== "HEAD")).toEqual([
      { method: "GET", url: "/v1/organizers/:organizerId/members", access: "member" },
      { method: "POST", url: "/v1/organizers/:organizerId/invites", access: "owner" },
    ]);
    await app.close();
    expect(() =>
      build().app.get("/v1/staff/team", { config: { access: "member" } }, async () => ({})),
    ).toThrow(message("/v1/staff/team"));
    expect(() =>
      build().app.get(
        "/v1/organizers/:organizerIdx",
        { config: { access: "owner" } },
        async () => ({}),
      ),
    ).toThrow(message("/v1/organizers/:organizerIdx"));
    expect(() =>
      build().app.get(
        "/v1/organizers/:organizerId/open",
        { config: { access: "public" } },
        async () => ({}),
      ),
    ).toThrow(message("/v1/organizers/:organizerId/open"));
  });

  it("keeps admin routes under /v1/admin/, and nothing else there", async () => {
    const { app, inventory } = build();
    app.get("/v1/admin/activation-requests", { config: { access: "admin" } }, async () => ({}));
    await app.ready();
    expect(inventory.filter((route) => route.method !== "HEAD")).toEqual([
      { method: "GET", url: "/v1/admin/activation-requests", access: "admin" },
    ]);
    await app.close();
    expect(() =>
      build().app.get("/v1/staff/console", { config: { access: "admin" } }, async () => ({})),
    ).toThrow(
      "Route GET /v1/staff/console: admin routes, and only they, live under /v1/admin/, where the platform admin check runs.",
    );
    expect(() =>
      build().app.get("/v1/admin/open", { config: { access: "public" } }, async () => ({})),
    ).toThrow(/admin routes, and only they/);
  });

  it("lists the known kinds", () => {
    expect(ACCESS_KINDS).toEqual([
      "public",
      "staff",
      "member",
      "owner",
      "player",
      "admin",
      "device",
    ]);
  });
});

const facts = (
  url: string,
  access: Access,
  more: Readonly<{ idempotent?: boolean; guards?: readonly string[] }> = {},
) => ({
  name: `GET ${url}`,
  url,
  access,
  idempotent: more.idempotent ?? false,
  hasDecorator: (decorator: string) => (more.guards ?? []).includes(decorator),
});
const STAFF = (url: string) =>
  `Route GET ${url} is marked staff but is outside /v1/staff/, where the session check runs.`;
const ADMIN = (url: string) =>
  `Route GET ${url}: admin routes, and only they, live under /v1/admin/, where the platform admin check runs.`;
const NO_PLAYER_GUARD = (url: string) =>
  `Route GET ${url} is marked player but the player guard is not registered before it.`;
const DEVICE_PATH = (url: string) =>
  `Route GET ${url} is marked device but is outside /v1/device, where the device check runs.`;
const NO_DEVICE_GUARD = (url: string) =>
  `Route GET ${url} is marked device but the device guard is not registered before it.`;
const PUBLIC_KEYS = (url: string) =>
  `Route GET ${url} is public, so it cannot take idempotency keys.`;

describe("routeRefusal", () => {
  // A route that breaks two rules is named by the earlier one.
  const PAIRS: ReadonlyArray<[string, ReturnType<typeof facts>, string]> = [
    [
      "staff vs organizer",
      facts("/v1/organizers/:organizerId/team", "staff"),
      STAFF("/v1/organizers/:organizerId/team"),
    ],
    [
      "admin vs public with keys",
      facts("/v1/admin/pay", "public", { idempotent: true }),
      ADMIN("/v1/admin/pay"),
    ],
    ["admin vs player guard", facts("/v1/admin/me", "player"), ADMIN("/v1/admin/me")],
    [
      "organizer vs player guard",
      facts("/v1/organizers/:organizerId/me", "player"),
      message("/v1/organizers/:organizerId/me"),
    ],
    ["device path vs device guard", facts("/v1/devices/x", "device"), DEVICE_PATH("/v1/devices/x")],
    ["admin vs device path", facts("/v1/admin/screen", "device"), ADMIN("/v1/admin/screen")],
  ];

  it.each(PAIRS)("names the earlier rule: %s", (_name, route, expected) => {
    expect(routeRefusal(route)).toBe(expected);
  });

  const SINGLES: ReadonlyArray<[ReturnType<typeof facts>, string]> = [
    [facts("/me", "staff"), STAFF("/me")],
    [facts("/v1/staff/x", "member"), message("/v1/staff/x")],
    [facts("/v1/staff/x", "admin"), ADMIN("/v1/staff/x")],
    [facts("/v1/me", "player"), NO_PLAYER_GUARD("/v1/me")],
    [facts("/v1/devices", "device", { guards: ["deviceGuard"] }), DEVICE_PATH("/v1/devices")],
    [facts("/v1/device/x", "device"), NO_DEVICE_GUARD("/v1/device/x")],
    [facts("/pay", "public", { idempotent: true }), PUBLIC_KEYS("/pay")],
  ];

  it.each(SINGLES)("refuses %j with its own message", (route, expected) => {
    expect(routeRefusal(route)).toBe(expected);
  });

  it("lets a route through only when it keeps every rule", () => {
    expect(routeRefusal(facts("/healthz", "public"))).toBeUndefined();
    expect(routeRefusal(facts("/v1/staff/me", "staff", { idempotent: true }))).toBeUndefined();
    expect(routeRefusal(facts("/v1/organizers/:organizerId", "owner"))).toBeUndefined();
    expect(routeRefusal(facts("/v1/admin/x", "admin"))).toBeUndefined();
    expect(routeRefusal(facts("/v1/me", "player", { guards: [PLAYER_GUARD] }))).toBeUndefined();
    expect(routeRefusal(facts("/v1/device", "device", { guards: [DEVICE_GUARD] }))).toBeUndefined();
  });

  it("asks the root server's decorators, so a guard on a child scope does not count", async () => {
    const app = Fastify();
    registerRouteInventory(app);
    await app.register(async (scope) => {
      scope.decorate(PLAYER_GUARD, true);
      expect(() => scope.get("/v1/me", { config: { access: "player" } }, async () => ({}))).toThrow(
        NO_PLAYER_GUARD("/v1/me"),
      );
    });
  });
});
