import type { PoolClient } from "pg";
import { imageUnknown } from "#src/auth/http-errors";
import type { HttpError } from "#src/http-error";
import type { ImagePurpose } from "#src/storage/images";

/** One image a save names: the field it sits in (the error names it), the id and the kind that field takes. */
export type ImageRef = Readonly<{ field: string; id: string; purpose: ImagePurpose }>;

/** The refusal of a save that named an unknown image, with its field; undefined for any other database error. */
export function imageRefusal(error: unknown): HttpError | undefined {
  const pg = error as { code?: unknown; detail?: unknown };
  return pg.code === "MI422"
    ? imageUnknown({ field: typeof pg.detail === "string" ? pg.detail : "image" })
    : undefined;
}

/**
 * Names the images of a save inside the save's own transaction (media_images_use, migration 0194): each must be a stored
 * image of this event of its field's kind, and is marked used, so the sweep keeps it. Throws 422 `image_unknown` with the
 * field otherwise, which rolls the save back. A save naming no image asks nothing.
 */
export async function useImages(
  client: PoolClient,
  eventId: string,
  refs: readonly ImageRef[],
): Promise<void> {
  try {
    await nameImages(client, eventId, refs);
  } catch (error) {
    throw imageRefusal(error) ?? error;
  }
}

/** The same call with the database's MI422 left as it is, for a caller that maps refusals itself (the quest builder). */
export async function nameImages(
  client: PoolClient,
  eventId: string,
  refs: readonly ImageRef[],
): Promise<void> {
  if (refs.length === 0) return;
  await client.query("SELECT media_images_use($1, $2::uuid[], $3::text[], $4::text[])", [
    eventId,
    refs.map((ref) => ref.id),
    refs.map((ref) => ref.purpose),
    refs.map((ref) => ref.field),
  ]);
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/**
 * The images a quest's config names (T-305b, ADR-190): a game's faces and items (icons) or puzzle picture (a picture),
 * and a vote option's icon. The config is the one the registry already checked.
 */
export function questImages(type: string, config: unknown): ImageRef[] {
  const found = record(config);
  if (type === "game") {
    const images = record(found["images"]);
    const picture = images["picture"];
    return [
      ...ids(images["faces"]).map((id, index) => ({
        field: `config.images.faces.${index}`,
        id,
        purpose: "icon" as const,
      })),
      ...(typeof picture === "string"
        ? [{ field: "config.images.picture", id: picture, purpose: "picture" as const }]
        : []),
      ...ids(images["items"]).map((id, index) => ({
        field: `config.images.items.${index}`,
        id,
        purpose: "icon" as const,
      })),
    ];
  }
  if (type !== "vote" || !Array.isArray(found["options"])) return [];
  return found["options"].flatMap((option: unknown, index: number) => {
    const image = record(option)["image"];
    return typeof image === "string"
      ? [{ field: `config.options.${index}.image`, id: image, purpose: "icon" as const }]
      : [];
  });
}
