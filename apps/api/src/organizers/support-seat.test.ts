import { describe, expect, it } from "vitest";
import type { OrganizerPrincipal } from "#src/organizers/store";
import { routeKeyOf, supportMayUse, viewGrantOf } from "#src/organizers/support-seat";
import { ORGANIZER_PREFIX } from "#src/route-access";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const seat: OrganizerPrincipal = {
  id: "33333333-3333-4333-8333-333333333333",
  role: "editor",
  eventScope: [EVENT],
  support: [{ grantId: "g", eventId: EVENT, expiresAt: new Date(), kind: "edit" }],
};
const may = (method: string, path: string, eventId?: string) =>
  supportMayUse(
    method,
    `${ORGANIZER_PREFIX}${path}`,
    eventId === undefined ? {} : { eventId },
    seat,
  );

describe("supportMayUse (deny by default, review MAJOR 3)", () => {
  it("allows the granted event's routes, reads and writes", () => {
    expect(may("GET", "/events/:eventId", EVENT)).toBe(true);
    expect(may("PUT", "/events/:eventId/terms", EVENT)).toBe(true);
    expect(may("POST", "/events/:eventId/devices/:deviceId/revoke", EVENT)).toBe(true);
  });

  it("refuses another event of the organizer", () => {
    expect(may("GET", "/events/:eventId", OTHER)).toBe(false);
  });

  it("refuses device pairing and exports even inside the granted event", () => {
    expect(may("POST", "/events/:eventId/devices", EVENT)).toBe(false);
    expect(may("POST", "/events/:eventId/devices/preview", EVENT)).toBe(false);
    expect(may("POST", "/events/:eventId/exports/:kind", EVENT)).toBe(false);
    expect(may("GET", "/events/:eventId/devices", EVENT)).toBe(true);
  });

  it("allows only the frame's read among routes without an event", () => {
    expect(may("GET", "/events")).toBe(true);
    expect(may("HEAD", "/events")).toBe(true);
    expect(may("POST", "/events")).toBe(false);
    expect(may("GET", "/members")).toBe(false);
    expect(may("GET", "/alerts/me")).toBe(false);
    expect(may("DELETE", "/members/me")).toBe(false);
  });

  it("opens nothing when the principal has no events", () => {
    expect(
      supportMayUse(
        "GET",
        `${ORGANIZER_PREFIX}/events/:eventId`,
        { eventId: EVENT },
        {
          ...seat,
          eventScope: null,
        },
      ),
    ).toBe(false);
  });
});

describe("the view kind (T-712, ADR-521, ADR-524)", () => {
  const view: OrganizerPrincipal = {
    ...seat,
    eventScope: [EVENT, OTHER],
    support: [
      { grantId: "v", eventId: EVENT, expiresAt: new Date(), kind: "view" },
      { grantId: "e", eventId: OTHER, expiresAt: new Date(), kind: "edit" },
    ],
  };
  const viewMay = (method: string, path: string, eventId: string) =>
    supportMayUse(method, `${ORGANIZER_PREFIX}${path}`, { eventId }, view);

  it("refuses the quest codes and the rehearsal card under a view, not under an edit grant", () => {
    expect(viewMay("GET", "/events/:eventId/codes", EVENT)).toBe(false);
    expect(viewMay("HEAD", "/events/:eventId/rehearsal", EVENT)).toBe(false);
    expect(viewMay("GET", "/events/:eventId/players", EVENT)).toBe(true);
    expect(viewMay("GET", "/events/:eventId/codes", OTHER)).toBe(true);
    expect(viewMay("GET", "/events/:eventId/rehearsal", OTHER)).toBe(true);
  });

  it("finds the view grant of the request's event, else the first view for an event-less read", () => {
    expect(viewGrantOf({ eventId: EVENT }, view)?.grantId).toBe("v");
    expect(viewGrantOf({ eventId: OTHER }, view)).toBeUndefined();
    expect(viewGrantOf({}, view)?.grantId).toBe("v");
    expect(viewGrantOf({}, seat)).toBeUndefined();
    expect(
      viewGrantOf({ eventId: EVENT }, { id: seat.id, role: "editor", eventScope: null }),
    ).toBeUndefined();
  });

  it("keys a route by its method (HEAD as GET) and pattern below the prefix", () => {
    expect(routeKeyOf("HEAD", `${ORGANIZER_PREFIX}/events/:eventId`)).toBe("GET /events/:eventId");
    expect(routeKeyOf("POST", `${ORGANIZER_PREFIX}/events`)).toBe("POST /events");
  });
});
