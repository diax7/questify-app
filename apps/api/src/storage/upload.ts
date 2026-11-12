import type { Pool, PoolClient } from "pg";
import {
  busy,
  enrollmentInactive,
  featureOff,
  idempotencyKeyReused,
  notFound,
  notSubmissionQuest,
  photoNotAccepted,
  photosOff,
  photoType,
  photoUnreadable,
  questNotOpen,
  storageUnavailable,
  ticketNotMember,
  ticketSendingClosed,
  tooManyPhotos,
} from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";
import type { ObjectStore } from "#src/storage/client";
import { ImageError, reencode, sniff, type ImageGate } from "#src/storage/images";

export type PhotoDeps = Readonly<{
  pool: Pool;
  storage?: ObjectStore | undefined;
  gate?: ImageGate;
}>;

export type PhotoUpload = Readonly<{
  playerId: string;
  purpose: "submission" | "ticket";
  /** The ticket's event (purpose `ticket`). */
  eventId: string | null;
  /** The submission's quest (purpose `submission`). */
  questId: string | null;
  idempotencyKey: string;
  body: Buffer;
}>;

/** What the caller must answer with besides the error: the seconds to wait (429, and busy). */
export class PhotoRefused extends Error {
  readonly error: HttpError;
  readonly retryAfterSeconds: number | undefined;

  constructor(error: HttpError, retryAfterSeconds?: number) {
    super(error.message);
    this.name = "PhotoRefused";
    this.error = error;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const TICKET_FORBIDDEN: Readonly<Record<string, () => HttpError>> = {
  not_member: () => ticketNotMember(),
  feature_off: () => featureOff(),
  sending_closed: () => ticketSendingClosed(),
};

/** The upload doors' SQLSTATEs (migration 0192), each one answer (a Map, so `toString` names none). */
const REFUSALS = new Map<string, (detail: string) => PhotoRefused>([
  ["QC404", () => new PhotoRefused(notFound())],
  ["QC403", (detail) => new PhotoRefused(enrollmentInactive({ reason: detail }))],
  ["QN403", (detail) => new PhotoRefused(questNotOpen({ reason: detail }))],
  ["SQ422", () => new PhotoRefused(notSubmissionQuest())],
  ["SM422", () => new PhotoRefused(photoNotAccepted())],
  ["QK422", () => new PhotoRefused(idempotencyKeyReused())],
  ["MD429", (detail) => new PhotoRefused(tooManyPhotos(), Number(detail) || 60)],
  ["HT403", (detail) => new PhotoRefused((TICKET_FORBIDDEN[detail] ?? ticketNotMember)())],
]);

/** The refusal a door's error stands for; undefined for anything else, which is thrown as it is. */
const refusalOf = (pg: Readonly<{ code?: string; detail?: string }>): PhotoRefused | undefined =>
  REFUSALS.get(pg.code ?? "")?.(pg.detail ?? "");

const asPlayer = async <T>(
  deps: PhotoDeps,
  playerId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId }, () => work(client)),
    );
  } catch (error) {
    throw refusalOf(error as { code?: string; detail?: string }) ?? error;
  }
};

type Slot = Readonly<{ id: string; key: string; stored: boolean }>;

const reserveSlot = (deps: PhotoDeps, upload: PhotoUpload): Promise<Slot> =>
  asPlayer(deps, upload.playerId, async (client) => {
    const { rows } = await client.query<Slot>("SELECT * FROM media_reserve($1, $2, $3, $4)", [
      upload.purpose,
      upload.eventId,
      upload.questId,
      upload.idempotencyKey,
    ]);
    return rows[0] as Slot;
  });

const releaseSlot = (deps: PhotoDeps, playerId: string, slot: Slot): Promise<unknown> =>
  asPlayer(deps, playerId, (client) => client.query("SELECT media_release($1)", [slot.id]));

const imageRefusal = (error: ImageError): PhotoRefused =>
  error.kind === "busy"
    ? new PhotoRefused(busy(), 2)
    : new PhotoRefused(error.kind === "photo_type" ? photoType() : photoUnreadable());

/** The stored JPEG, or the refusal; a refused image gives its slot back so it does not count toward the cap. */
async function encoded(deps: PhotoDeps, upload: PhotoUpload, slot: Slot) {
  try {
    return await reencode(upload.body, deps.gate);
  } catch (error) {
    if (!(error instanceof ImageError)) throw error;
    if (error.kind !== "busy") await releaseSlot(deps, upload.playerId, slot);
    throw imageRefusal(error);
  }
}

/**
 * One photo upload (T-301b): the bytes are sniffed first (415 before any slot), then a slot is reserved under the
 * caller's seat, the image re-encoded, PUT to the bucket outside any transaction, and the slot marked stored. A retry
 * with the same key finds its slot (and answers at once when it is stored). A slot swept while the upload ran has its
 * object queued for deletion by the database, and the caller is asked to send again.
 */
export async function uploadPhoto(
  deps: PhotoDeps,
  upload: PhotoUpload,
): Promise<{ photoId: string }> {
  if (deps.storage === undefined) throw new PhotoRefused(photosOff());
  if (sniff(upload.body) === undefined) throw new PhotoRefused(photoType());
  const slot = await reserveSlot(deps, upload);
  if (slot.stored) return { photoId: slot.id };
  const image = await encoded(deps, upload, slot);
  try {
    await deps.storage.put(slot.key, image.body);
  } catch {
    throw new PhotoRefused(storageUnavailable());
  }
  const stored = await asPlayer(deps, upload.playerId, async (client) => {
    const { rows } = await client.query<{ ok: boolean }>(
      "SELECT media_stored($1, $2, $3, $4, $5) AS ok",
      [slot.id, slot.key, image.body.length, image.width, image.height],
    );
    return rows[0]?.ok === true;
  });
  if (!stored) throw new PhotoRefused(storageUnavailable());
  return { photoId: slot.id };
}
