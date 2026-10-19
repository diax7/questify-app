import type { Client, PoolClient } from "pg";
import { findSecretKey, isAction } from "#src/audit/entry";

export type AuditActor =
  | Readonly<{ type: "admin"; id: string }>
  | Readonly<{ type: "staff"; id: string }>
  | Readonly<{ type: "system" }>;

export type AuditEntry = Readonly<{
  actor: AuditActor;
  /** Dotted lower-case words, such as `platform_settings.update`. */
  action: string;
  target: Readonly<{ type: string; id?: string | undefined }>;
  organizerId?: string | undefined;
  eventId?: string | undefined;
  before?: Readonly<Record<string, unknown>> | undefined;
  after?: Readonly<Record<string, unknown>> | undefined;
  /** The request id (also in the server log line), so an entry can be traced to its request. */
  requestId?: string | undefined;
}>;

/** What a service passes down about the request, for the audit entry. */
export type AuditMeta = Readonly<{ requestId?: string | undefined }>;

/**
 * Writes one audit entry inside the transaction the caller already opened, so the change and its entry are saved or
 * dropped together. Nothing is read back (the caller may not be allowed to read the entry it writes).
 *
 * @throws Error when the action is not a dotted name, or when the entry would hold a secret or personal data. The
 *   error rolls back the change as well: a permanent record must never be the place a secret leaks to.
 */
export async function recordAudit(client: Client | PoolClient, entry: AuditEntry): Promise<void> {
  if (!isAction(entry.action)) {
    throw new Error(
      `Audit action "${entry.action}" must be dotted lower-case words, like event.update.`,
    );
  }
  const forbidden = findSecretKey({ before: entry.before, after: entry.after });
  if (forbidden !== undefined) {
    throw new Error(
      `Audit entry ${entry.action} must not hold "${forbidden}": no secrets or personal data.`,
    );
  }
  await client.query(
    `INSERT INTO audit_log
       (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.actor.type,
      entry.actor.type === "system" ? null : entry.actor.id,
      entry.organizerId ?? null,
      entry.eventId ?? null,
      entry.action,
      entry.target.type,
      entry.target.id ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.requestId ?? null,
    ],
  );
}
