import { createHmac } from "node:crypto";
import { safeEqual } from "#src/auth/keys";

const MIN_SECRET_LENGTH = 32;
const FORMAT = 0x01;
const ID_BYTES = 16;
const IDS = 4;
const EXPIRY_BYTES = 4;
const MAC_BYTES = 16;
const SIGNED_BYTES = 1 + ID_BYTES * IDS + EXPIRY_BYTES;
const TICKET_BYTES = SIGNED_BYTES + MAC_BYTES;
/** 85 bytes in base64url, no padding. */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{114}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How long a prepared write may be confirmed (CTO B): a write, read-back and lock take seconds. */
export const TICKET_SECONDS = 300;

/** The key of write tickets, derived from `QR_SECRET` for this one purpose. */
export type TicketKey = Readonly<{ key: Buffer }>;

/** What a ticket binds: one prepared tag, for one quest of one event, for the operator who prepared it. */
export type TicketFields = Readonly<{
  eventId: string;
  questId: string;
  operatorId: string;
  tagId: string;
}>;

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createTicketKey(secret: string): TicketKey {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`QR_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return { key: createHmac("sha256", secret).update("questify/nfc/v1/ticket").digest() };
}

const idBytes = (id: string): Buffer => {
  const lower = id.toLowerCase();
  if (!UUID.test(lower)) {
    throw new Error(`Not an id: ${id}`);
  }
  return Buffer.from(lower.replaceAll("-", ""), "hex");
};

const fieldBytes = (fields: TicketFields): Buffer =>
  Buffer.concat([
    idBytes(fields.eventId),
    idBytes(fields.questId),
    idBytes(fields.operatorId),
    idBytes(fields.tagId),
  ]);

const mac = (key: TicketKey, signed: Buffer): Buffer =>
  createHmac("sha256", key.key).update(signed).digest().subarray(0, MAC_BYTES);

/**
 * A short-lived write ticket (CTO B): the four ids and an expiry, signed. Nothing is stored: confirm checks it was
 * issued for the same event, quest, operator and tag, and has not expired. Never personal, never shown to anyone.
 */
export function issueTicket(key: TicketKey, fields: TicketFields, nowMs: number): string {
  const signed = Buffer.alloc(SIGNED_BYTES);
  signed[0] = FORMAT;
  fieldBytes(fields).copy(signed, 1);
  signed.writeUInt32BE(Math.floor(nowMs / 1000) + TICKET_SECONDS, 1 + ID_BYTES * IDS);
  return Buffer.concat([signed, mac(key, signed)]).toString("base64url");
}

/**
 * Whether a ticket was issued for exactly these ids and is still in time. Strict: the canonical encoding only, then
 * the signature in constant time, then the ids and the expiry.
 */
export function ticketHolds(
  key: TicketKey,
  ticket: string,
  fields: TicketFields,
  nowMs: number,
): boolean {
  if (!TICKET_SHAPE.test(ticket)) {
    return false;
  }
  const bytes = Buffer.from(ticket, "base64url");
  if (
    bytes.length !== TICKET_BYTES ||
    bytes.toString("base64url") !== ticket ||
    bytes[0] !== FORMAT
  ) {
    return false;
  }
  const signed = bytes.subarray(0, SIGNED_BYTES);
  if (!safeEqual(mac(key, signed), bytes.subarray(SIGNED_BYTES))) {
    return false;
  }
  const expiry = signed.readUInt32BE(1 + ID_BYTES * IDS);
  return (
    signed.subarray(1, 1 + ID_BYTES * IDS).equals(fieldBytes(fields)) &&
    Math.floor(nowMs / 1000) <= expiry
  );
}
