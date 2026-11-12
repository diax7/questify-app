import type { LocalizedText, MessageKey } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";

/** The types the server takes (T-301b); it checks the bytes again and answers 415 for anything else, HEIC among them. */
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** The longest caption a photo may carry (the database's limit, migration 0193). */
export const CAPTION_MAX = 300;

/**
 * A photo the player took or picked, held until it is sent: where it is (for the preview), its type, and on the web the
 * file itself (the page's CSP lets it fetch no `blob:` or `data:` URI).
 */
export type PickedPhoto = Readonly<{ uri: string; type: PhotoType; file: Blob | null }>;

/** What the camera or the picker gave back, in the words the sheet needs. */
export type PickAnswer =
  | Readonly<{ kind: "picked"; photo: PickedPhoto }>
  | Readonly<{ kind: "cancelled" }>
  /** The camera permission was refused: the sheet says how to allow it. */
  | Readonly<{ kind: "denied" }>
  /** A photo of a type the server would refuse (HEIC from an older iPhone setting): the sheet says so. */
  | Readonly<{ kind: "unsupported" }>
  /** This build has no picker (an update reached an older binary): the sheet asks for an app update. */
  | Readonly<{ kind: "unavailable" }>;

/** The type a picked asset names, when the server takes it; `image/jpg` is read as JPEG. */
export function photoTypeOf(mimeType: string | null | undefined): PhotoType | undefined {
  const type = mimeType?.toLowerCase() === "image/jpg" ? "image/jpeg" : mimeType?.toLowerCase();
  return (PHOTO_TYPES as readonly string[]).includes(type ?? "") ? (type as PhotoType) : undefined;
}

export type UploadAnswer =
  | Readonly<{ kind: "uploaded"; photoId: string }>
  | Readonly<{ kind: "refused"; message: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

export function uploadAnswer(answer: AuthedResult): UploadAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") return { kind: answer.kind };
  if (answer.kind === "error") return { kind: "refused", message: answer.message };
  const body = answer.body as { photoId?: unknown } | null;
  return typeof body?.photoId === "string"
    ? { kind: "uploaded", photoId: body.photoId }
    : { kind: "network" };
}

/** A photo upload's own limit: up to 8 MB on a venue's network. */
const UPLOAD_TIMEOUT_MS = 90_000;

/**
 * Sends one photo's bytes to its door (`/v1/quests/{id}/photo` or `/v1/events/{id}/tickets/photo`) with one
 * Idempotency-Key per photo, so a retry after a dropped connection stores it once. The session refreshes the token first
 * when it is about to end.
 */
export async function uploadPhoto(
  session: Pick<Session, "request">,
  path: string,
  photo: Readonly<{ data: Blob; type: PhotoType }>,
  key: string,
): Promise<UploadAnswer> {
  return uploadAnswer(
    await session.request({
      method: "POST",
      path,
      raw: { data: photo.data, type: photo.type },
      timeoutMs: UPLOAD_TIMEOUT_MS,
      headers: { "idempotency-key": key },
    }),
  );
}

export const questPhotoPath = (questId: string): string =>
  `/v1/quests/${encodeURIComponent(questId)}/photo`;

export const ticketPhotoPath = (eventId: string): string =>
  `/v1/events/${encodeURIComponent(eventId)}/tickets/photo`;

/** What a submission quest asks for, from the quest list (`accepts`); an older API sends nothing, which is text. */
export function acceptsOf(quest: Readonly<{ submission: { accepts: readonly string[] } | null }>) {
  const accepts = quest.submission?.accepts ?? ["text"];
  return { text: accepts.includes("text"), photo: accepts.includes("photo") };
}

/** Whether Send may be pressed: a photo when the quest needs one, text when it takes text only, a short caption. */
export function canSendPhoto(
  accepts: Readonly<{ text: boolean; photo: boolean }>,
  photo: PickedPhoto | null,
  text: string,
): boolean {
  const length = text.trim().length;
  if (photo !== null) return accepts.photo && length <= CAPTION_MAX;
  return accepts.text && length >= 1 && length <= 1000;
}

/** The line a pick answer shows under the photo, or null when there is nothing to say. */
export function pickLine(answer: PickAnswer): MessageKey | null {
  switch (answer.kind) {
    case "denied":
      return "photo.cameraDenied";
    case "unsupported":
      return "photo.unsupported";
    case "unavailable":
      return "photo.updateApp";
    default:
      return null;
  }
}
