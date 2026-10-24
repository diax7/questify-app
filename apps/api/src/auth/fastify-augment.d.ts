import type { PublicAccount } from "#src/auth/staff-store";
import type { OrganizerPrincipal } from "#src/organizers/store";

/** The signed-in staff member behind a request, set by the staff scope after the session checks out. */
export type StaffPrincipal = Readonly<{ account: PublicAccount; sessionId: string }>;

declare module "fastify" {
  interface FastifyRequest {
    /** Set only on staff routes that passed the session check. */
    staff?: StaffPrincipal;
    /** Set only on organizer routes, for a member of that organizer. */
    organizer?: OrganizerPrincipal;
    /** Set only on player routes, for a player whose bearer token checked out (players/guard.ts). */
    player?: Readonly<{ id: string }>;
    /** Set only on device routes, for a browser whose device cookie opened a row (devices/guard.ts, T-309). */
    device?: import("#src/devices/guard").DeviceIdentity;
    /** Who owns the request's idempotency keys: the staff user id once signed in, `player:<id>` for a player. */
    principalId?: string;
  }

  interface FastifyContextConfig {
    /** Who may call the route (route-access.ts). Required: a route without it stops the server from starting. */
    access?: import("#src/route-access").Access;
    /**
     * A device route a pending or not yet activated device may call (`GET /v1/device`, renew, activate); every other
     * device route needs a paired, activated device (T-309).
     */
    anyDevice?: boolean;
  }
}
