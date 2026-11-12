import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLAY_DOORS } from "#src/maintenance/gate";
import { startApp, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * The player and device write routes that maintenance mode leaves open (T-703b, ADR-471), by what keeps each one safe to
 * leave open. A route that earns or spends belongs in `PLAY_DOORS` (src/maintenance/gate.ts) instead: the walk below
 * fails for a route that is on neither list, so a new earning door cannot ship unpaused.
 */
const OPEN_WRITES: Readonly<Record<string, readonly string[]>> = {
  // The player's own account and safety: nothing here moves points or XP.
  "the player's own account, settings and safety": [
    "DELETE /v1/me/blocks/:username",
    "DELETE /v1/me/push-device",
    "PATCH /v1/me",
    "POST /v1/me/acceptances",
    "POST /v1/me/blocks",
    "POST /v1/me/contact/code",
    "POST /v1/me/contact/verify",
    "POST /v1/me/data-export",
    "POST /v1/me/deletion/code",
    "POST /v1/me/devices/:id/end",
    "POST /v1/me/devices/end-others",
    "POST /v1/me/locker/seen",
    "POST /v1/me/notifications/read",
    "POST /v1/me/qr/reset",
    "POST /v1/me/reauth/code",
    "POST /v1/me/reauth/verify",
    "POST /v1/reports",
    "PUT /v1/me/marketing",
    "PUT /v1/me/preferences",
    "PUT /v1/me/push-device",
    "PUT /v1/me/push-topics",
  ],
  // A player can always step out, and an undone reservation or offer gives points back (ADR-471).
  "leaving, declining and cancelling": [
    "POST /v1/events/:eventId/leave",
    "POST /v1/desk-sales/:saleId/decline",
    "POST /v1/redemptions/:redemptionId/cancel",
    "POST /v1/redemptions/:redemptionId/decline",
    "POST /v1/operator/desk/sales/:saleId/withdraw",
    "POST /v1/operator/redemptions/:redemptionId/cancel",
  ],
  // The points were spent when the prize was reserved; handing it over pays and spends nothing.
  "prize handover": [
    "POST /v1/redemptions/:redemptionId/accept",
    "POST /v1/redemptions/:redemptionId/collect",
    "POST /v1/operator/redemptions/:redemptionId/hand-over",
  ],
  // Support, agenda seats, cheers and ratings pay nothing: a seat earns at the check-in, which is held.
  "help desk, agenda seats, cheers and ratings (earn nothing)": [
    "POST /v1/events/:eventId/cheers",
    "POST /v1/events/:eventId/sessions/:sessionId/cancel",
    "POST /v1/events/:eventId/sessions/:sessionId/register",
    "POST /v1/events/:eventId/tickets",
    "POST /v1/events/:eventId/tickets/photo",
    "POST /v1/events/:eventId/tickets/seen",
    "POST /v1/me/tickets",
    "POST /v1/me/tickets/seen",
    "POST /v1/operator/events/:eventId/tickets/:ticketId/answer",
    "PUT /v1/quests/:questId/rating",
  ],
  // The station's set-up and look-ups: they find a player or a tag, or offer a sale the player must accept (held).
  "operator set-up, look-ups and practice (no points)": [
    "POST /v1/operator-invites/claim",
    "POST /v1/operator-invites/preview",
    "POST /v1/operator/desk/lookup",
    "POST /v1/operator/desk/sale-rewards",
    "POST /v1/operator/desk/sales",
    "POST /v1/operator/events/:eventId/desk/find",
    "POST /v1/operator/events/:eventId/devices",
    "POST /v1/operator/events/:eventId/devices/:deviceId/revoke",
    "POST /v1/operator/events/:eventId/devices/preview",
    "POST /v1/operator/events/:eventId/find-player",
    "POST /v1/operator/events/:eventId/quests/:questId/nfc-tags",
    "POST /v1/operator/events/:eventId/quests/:questId/nfc-tags/prepare",
    "POST /v1/operator/scan/practice",
  ],
  // A one-minute code to show (the review demo's from a fictional player, T-710b); the meeting that pays is
  // POST /v1/meet. Rehearsals are the team's wiped sandbox.
  "codes to show and the rehearsal sandbox": [
    "POST /v1/events/:eventId/review-codes/meet",
    "POST /v1/quests/:questId/meet-pass",
    "POST /v1/rehearsals/join",
  ],
  // A station or screen pairing itself.
  "device pairing": ["POST /v1/device/activate", "POST /v1/device/pairing/renew"],
};

const OPEN = Object.values(OPEN_WRITES).flat();
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "maintenance mode holds every earning door",
  () => {
    let db: TestDatabase;
    let test: TestApp;
    let walked: string[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
      test = await startApp(db);
      walked = test.app.routeInventory
        .filter((route) => route.access === "player" || route.access === "device")
        .filter((route) => WRITES.has(route.method))
        .map((route) => `${route.method} ${route.url}`);
    });
    afterAll(async () => {
      await test.close();
      await db.close();
    });

    it("finds every player and device write route on the held list or the open list", () => {
      const held = new Set(Object.keys(PLAY_DOORS));
      const open = new Set(OPEN);
      expect(walked.length).toBeGreaterThan(50);
      expect(walked.filter((route) => !held.has(route) && !open.has(route))).toEqual([]);
    });

    it("has no held or open entry for a route that does not exist, and none on both lists", () => {
      const real = new Set(walked);
      const names = [...Object.keys(PLAY_DOORS), ...OPEN];
      expect(names.filter((route) => !real.has(route))).toEqual([]);
      expect(OPEN.filter((route) => route in PLAY_DOORS)).toEqual([]);
      expect(new Set(OPEN).size).toBe(OPEN.length);
    });
  },
);
