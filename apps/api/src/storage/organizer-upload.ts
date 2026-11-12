import type { Pool, PoolClient } from "pg";
import {
  idempotencyKeyReused,
  imageEventClosed,
  notFound,
  photosOff,
  photoType,
  tooManyImages,
} from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { teamSeat, type OrganizerContext } from "#src/organizers/store";
import type { ObjectStore } from "#src/storage/client";
import {
  IMAGE_SHAPES,
  reencodeFor,
  sniff,
  type ImageGate,
  type ImagePurpose,
} from "#src/storage/images";
import { PhotoRefused, storeUpload, type Slot } from "#src/storage/upload";

export type OrganizerImageDeps = Readonly<{
  pool: Pool;
  storage?: ObjectStore | undefined;
  gate?: ImageGate;
}>;

export type OrganizerImageUpload = Readonly<{
  team: OrganizerContext;
  eventId: string;
  purpose: ImagePurpose;
  idempotencyKey: string;
  body: Buffer;
}>;

export type StoredImage = Readonly<{ imageId: string; width: number; height: number }>;

/** The organizer image doors' SQLSTATEs (migration 0194), each one answer. */
const REFUSALS = new Map<string, (detail: string) => PhotoRefused>([
  ["AN404", () => new PhotoRefused(notFound())],
  ["MI409", () => new PhotoRefused(imageEventClosed())],
  ["QK422", () => new PhotoRefused(idempotencyKeyReused())],
  ["MD429", (detail) => new PhotoRefused(tooManyImages(), Number(detail) || 60)],
]);

const asTeam = async <T>(
  deps: OrganizerImageDeps,
  team: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, teamSeat(team), () => work(client)),
    );
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    throw REFUSALS.get(pg.code ?? "")?.(pg.detail ?? "") ?? error;
  }
};

type ImageSlot = Slot & Readonly<{ width: number | null; height: number | null }>;

/**
 * One organizer image upload (ADR-829 (2)): 503 without a bucket, 415 for bytes that are no image, then the shared
 * `storeUpload` under the team's seat with this kind's encoder (a PNG for logos and icons). A repeat with the same key
 * answers the stored image's id and size.
 */
export async function uploadOrganizerImage(
  deps: OrganizerImageDeps,
  upload: OrganizerImageUpload,
): Promise<StoredImage> {
  const storage = deps.storage;
  if (storage === undefined) throw new PhotoRefused(photosOff());
  if (sniff(upload.body) === undefined) throw new PhotoRefused(photoType());
  const { slot, image } = await storeUpload<ImageSlot>({
    storage,
    contentType: IMAGE_SHAPES[upload.purpose].png ? "image/png" : "image/jpeg",
    reserve: () =>
      asTeam(deps, upload.team, async (client) => {
        const { rows } = await client.query<ImageSlot>(
          "SELECT * FROM media_image_reserve($1, $2, $3)",
          [upload.eventId, upload.purpose, upload.idempotencyKey],
        );
        return rows[0] as ImageSlot;
      }),
    release: (taken) =>
      asTeam(deps, upload.team, (client) =>
        client.query("SELECT media_image_release($1)", [taken.id]),
      ),
    encode: () => reencodeFor(upload.purpose, upload.body, deps.gate),
    stored: (taken, made) =>
      asTeam(deps, upload.team, async (client) => {
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT media_image_stored($1, $2, $3, $4, $5) AS ok",
          [taken.id, taken.key, made.body.length, made.width, made.height],
        );
        return rows[0]?.ok === true;
      }),
  });
  return answerOf(slot, image);
}

/** The new image's id and size: as just encoded, or as stored by the first try of the same key. */
const answerOf = (
  slot: ImageSlot,
  image: Readonly<{ width: number; height: number }> | undefined,
): StoredImage =>
  image === undefined
    ? { imageId: slot.id, width: slot.width ?? 0, height: slot.height ?? 0 }
    : { imageId: slot.id, width: image.width, height: image.height };
