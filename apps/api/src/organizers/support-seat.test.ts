import { describe, expect, it } from "vitest";
import type { OrganizerPrincipal } from "#src/organizers/store";
import { supportMayUse } from "#src/organizers/support-seat";
import { ORGANIZER_PREFIX } from "#src/route-access";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const seat: OrganizerPrincipal = {
  id: "33333333-3333-4333-8333-333333333333",
  role: "editor",
  eventScope: [EVENT],
  support: [{ grantId: "g", eventId: EVENT, expiresAt: new Date() }],
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
