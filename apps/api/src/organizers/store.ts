import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** The caller's membership of the organizer in the URL, read from the database by the organizer scope. */
export type OrganizerPrincipal = Readonly<{
  id: string;
  role: "owner" | "editor";
  /** The events an editor is limited to; null means every event. */
  eventScope: readonly string[] | null;
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
export type OrganizerContext = Readonly<{ staffUserId: string; organizerId: string }>;

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
      }>(
        "SELECT role, event_scope FROM organizer_member WHERE organizer_id = $1 AND staff_user_id = $2",
        [organizerId, staffUserId],
      );
      const row = rows[0];
      return row === undefined
        ? undefined
        : { id: organizerId, role: row.role, eventScope: row.event_scope };
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
