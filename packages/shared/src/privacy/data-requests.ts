import { z } from "zod";

/**
 * Legal data requests (T-708, FR-1418, FR-1778, ADR-480 to ADR-485). The reason codes and the case reference rule are
 * the ones the database checks (`data_request_reason`, migration 0129): the console form and the route check them first.
 */
export const DATA_REQUEST_REASONS = ["legal_request", "player_request"] as const;
export type DataRequestReason = (typeof DATA_REQUEST_REASONS)[number];

export const isDataRequestReason = (value: unknown): value is DataRequestReason =>
  typeof value === "string" && (DATA_REQUEST_REASONS as readonly string[]).includes(value);

const REFERENCE_SHAPE = /^[A-Za-z0-9._/-]{3,64}$/;
const HAS_LETTER = /[A-Za-z]/;
const LONG_DIGITS = /[0-9]{8,}/;

/**
 * Whether the text is an opaque case reference: 3 to 64 of `A-Z a-z 0-9 . _ / -`, at least one letter and no run of 8
 * or more digits, so no name, email, phone or national id can be typed into the durable audit record.
 */
export function isCaseReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REFERENCE_SHAPE.test(value) &&
    HAS_LETTER.test(value) &&
    !LONG_DIGITS.test(value)
  );
}

/** One export or erasure of the player, as the console record lists it (newest first). */
export const legalRequestSchema = z.strictObject({
  at: z.string().min(1),
  action: z.enum(["player.data_export", "player.delete"]),
  source: z.enum(["player", "admin", "reapply"]),
  reasonCode: z.string().nullable(),
  reference: z.string().nullable(),
  by: z.string().nullable(),
});
export type LegalRequest = z.infer<typeof legalRequestSchema>;

/** The admin erase's answer: no personal data, so the idempotency store may keep it. */
export const dataEraseAnswerSchema = z.strictObject({
  outcome: z.enum(["erased", "already_deleted"]),
  events: z.array(z.uuid()),
});
export type DataEraseAnswer = z.infer<typeof dataEraseAnswerSchema>;

/** A handover still waiting before an admin erase (the self-deletion's shape). */
export const pendingHandoverSchema = z.strictObject({
  redemptionId: z.uuid(),
  eventId: z.uuid(),
  event: z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() }),
  item: z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() }),
  rankPrize: z.boolean(),
});
export type PendingHandoverItem = z.infer<typeof pendingHandoverSchema>;

/** `GET /v1/admin/players/:id/pending`. */
export const pendingAnswerSchema = z.strictObject({ pending: z.array(pendingHandoverSchema) });

/** The file's name on the device or in the browser: `questify-data-2026-11-03.json` (UTC date, Western digits). */
export function dataExportFileName(at: Date): string {
  return `questify-data-${at.toISOString().slice(0, 10)}.json`;
}
