import { z } from "zod";

/**
 * Organizer images (ADR-829): an owner or editor uploads an image of one kind for one event, and the event's settings
 * name it by id only, never by URL. Each holder takes one kind: logos and icons are stored as PNG (transparency kept),
 * banners, pictures and maps as JPEG. The same list is migration 0194's CHECK.
 */
export const IMAGE_PURPOSES = ["logo", "icon", "banner", "picture", "map"] as const;
export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

/** The types an upload may be sent as; HEIC is not one. The server checks the bytes again. */
export const IMAGE_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** The largest upload, as for player photos (Q-150). */
export const IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

/** An image id as a setting stores it: a uuid, always lowercase. */
export const imageIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase());

/** A stored image with its size, as a map carries its picture (the board takes its aspect from it). */
export const sizedImageSchema = z.object({
  id: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type SizedImage = z.infer<typeof sizedImageSchema>;

/** `POST …/events/{e}/images?purpose=` answers the new image's id and stored size. */
export const storedImageSchema = z.object({
  imageId: z.string(),
  width: z.number(),
  height: z.number(),
});
export type StoredImage = z.infer<typeof storedImageSchema>;

/** The player's read of an image: a 302 to a short signed URL, so an image cache keys on this stable path. */
export const eventImagePath = (eventId: string, imageId: string): string =>
  `/v1/events/${eventId}/images/${imageId}`;

/** The team's read of the same image, for the dashboard's previews. */
export const teamImagePath = (organizerId: string, eventId: string, imageId: string): string =>
  `/v1/organizers/${organizerId}/events/${eventId}/images/${imageId}`;

/** The upload door for an image of `purpose`. */
export const imageUploadPath = (
  organizerId: string,
  eventId: string,
  purpose: ImagePurpose,
): string => `/v1/organizers/${organizerId}/events/${eventId}/images?purpose=${purpose}`;
