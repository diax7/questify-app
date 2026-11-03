import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import type { LegalPending, Suspension, SupportGrant } from "#src/auth/staff-store";
import { withRequestContext, type RequestContext } from "#src/db/context";

/** The caller's membership of the organizer in the URL, read from the database by the organizer scope. */
export type OrganizerPrincipal = Readonly<{
  id: string;
  role: "owner" | "editor";
  /** The events an editor is limited to; null means every event. */
  eventScope: readonly string[] | null;
  /** Questify paused this organizer (T-701): its writes answer 423 while this is set. */
  suspension?: Suspension | null;
  /** Organizer documents in force that the owner has not accepted: the team's writes are refused until then (T-707). */
  legalPending?: readonly LegalPending[];
  /** A Questify admin on support grants instead of a member (ADR-407): editor of these events only. */
  support?: readonly SupportGrant[];
  /** This request reads an event under a support `view` grant (T-712, ADR-521): its transactions open READ ONLY. */
  readOnly?: true;
}>;

export type TeamMember = Readonly<{
  staffUserId: string;
  email: string;
  role: "owner" | "editor";
  eventScope: string[] | null;
  joinedAt: Date;
}>;

export type PendingInvite = Readonly<{
  id: string;
  email: string;
  role: "owner" | "editor";
  eventScope: string[] | null;
  expiresAt: Date;
}>;

/** The context every organizer query runs in: the caller and the organizer they are a member of. */
export type OrganizerContext = Readonly<{
  staffUserId: string;
  organizerId: string;
  /** A support admin's view (T-712, ADR-521): carried into every seat so the database honours the view grant. */
  readOnly?: true;
}>;

/**
 * The row-level-security seat of an organizer context: the caller, the organizer and, for a support view, the read-only
 * mark (ADR-521). Every store builds its seat here, so a view request never runs read-write by a copied field missing.
 */
export const teamSeat = (context: OrganizerContext): RequestContext => ({
  organizerId: context.organizerId,
  staffUserId: context.staffUserId,
  ...(context.readOnly === true ? { readOnly: true } : {}),
});

/** The caller's own membership of an organizer, or undefined when they are not a member. */
export async function membershipOf(
  pool: Pool,
  staffUserId: string,
  organizerId: string,
): Promise<OrganizerPrincipal | undefined> {
  return withConnection(pool, (client) =>
    withRequestContext(client, { staffUserId }, async () => {
      const { rows } = await client.query<{
        role: "owner" | "editor";
        event_scope: string[] | null;
        suspension_reason: string | null;
        suspended_at: Date | null;
        legal_pending: LegalPending[];
      }>(
        `SELECT m.role, m.event_scope, o.suspension_reason, o.suspended_at,
                organizer_legal_missing(m.organizer_id) AS legal_pending
         FROM organizer_member m JOIN organizer o ON o.id = m.organizer_id
         WHERE m.organizer_id = $1 AND m.staff_user_id = $2`,
        [organizerId, staffUserId],
      );
      const row = rows[0];
      return row === undefined
        ? undefined
        : {
            id: organizerId,
            role: row.role,
            eventScope: row.event_scope,
            suspension:
              row.suspension_reason === null || row.suspended_at === null
                ? null
                : { reason: row.suspension_reason, since: row.suspended_at },
            legalPending: row.legal_pending,
          };
    }),
  );
}

/** The team and its pending invites, as the organizer's members may see them. */
export async function readTeam(
  pool: Pool,
  context: OrganizerContext,
): Promise<{ members: TeamMember[]; invites: PendingInvite[] }> {
  return withConnection(pool, (client) =>
    withRequestContext(client, context, async () => {
      const members = await client.query<{
        staff_user_id: string;
        email: string;
        role: "owner" | "editor";
        event_scope: string[] | null;
        joined_at: Date;
      }>("SELECT staff_user_id, email, role, event_scope, joined_at FROM team_members()");
      const invites = await client.query<{
        id: string;
        email: string;
        role: "owner" | "editor";
        event_scope: string[] | null;
        expires_at: Date;
      }>(
        `SELECT id, email, role, event_scope, expires_at FROM organizer_invite
         WHERE organizer_id = $1 AND expires_at > now() ORDER BY created_at`,
        [context.organizerId],
      );
      return {
        members: members.rows.map((row) => ({
          staffUserId: row.staff_user_id,
          email: row.email,
          role: row.role,
          eventScope: row.event_scope,
          joinedAt: row.joined_at,
        })),
        invites: invites.rows.map((row) => ({
          id: row.id,
          email: row.email,
          role: row.role,
          eventScope: row.event_scope,
          expiresAt: row.expires_at,
        })),
      };
    }),
  );
}
