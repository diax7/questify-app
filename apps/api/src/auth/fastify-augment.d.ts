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
    /** Who owns the request's idempotency keys: the staff user id once signed in. */
    principalId?: string;
  }

  interface FastifyContextConfig {
    /** Who may call the route (route-access.ts). Required: a route without it stops the server from starting. */
    access?: import("#src/route-access").Access;
  }
}
