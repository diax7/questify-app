import type { Pool } from "pg";
import { door, type Admin } from "#src/console/doors";

/**
 * Ends every live session of one staff account at once, with a reason (T-810c, FR-141, ADR-713): an organizer member
 * or another admin. Audited by the door (`staff.session.end_all`) with the reason and the count. The caller's own
 * account is refused (QA422) and an unknown one is not found (QA404).
 *
 * @returns how many sessions ended.
 */
export function endStaffAccountSessions(
  pool: Pool,
  admin: Admin,
  input: Readonly<{ staffUserId: string; reason: string; requestId: string }>,
): Promise<number> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ ended: number }>(
      "SELECT admin_end_staff_sessions($1, $2, $3) AS ended",
      [input.staffUserId, input.reason, input.requestId],
    );
    return rows[0]?.ended ?? 0;
  });
}
