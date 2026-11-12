import sharp from "sharp";

/** Uploads up to 8 MiB (Q-150), checked by the route's body limit before anything here runs. */
export const PHOTO_BYTES_MAX = 8 * 1024 * 1024;
/** The long side of a stored photo (Q-150). */
export const PHOTO_SIDE_MAX = 2048;
const JPEG_QUALITY = 82;
/**
 * The most pixels a photo may decode to: 32 MP (about 130 MB of pixels) until the API container's memory is measured
 * (plan section 10, item 12); a phone's 12 to 48 MP camera at quality 0.8 stays under it once the app downsizes.
 */
export const PIXELS_MAX = 32_000_000;
const RUNNING = 1;
const WAITING = 4;

sharp.concurrency(1);
sharp.cache(false);

export type ImageFormat = "jpeg" | "png" | "webp";

/** Why an upload is refused: not a JPEG, PNG or WebP by its bytes (415), not decodable (422), or no room (503). */
export class ImageError extends Error {
  readonly kind: "photo_type" | "photo_unreadable" | "busy";

  constructor(kind: ImageError["kind"]) {
    super(`image refused: ${kind}`);
    this.name = "ImageError";
    this.kind = kind;
  }
}

const startsWith = (body: Buffer, bytes: readonly number[], at = 0) =>
  body.length >= at + bytes.length && bytes.every((byte, i) => body[at + i] === byte);

/** The format the bytes are, by their magic numbers; never by the name or the declared type. HEIC is not one. */
export function sniff(body: Buffer): ImageFormat | undefined {
  if (startsWith(body, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(body, [0x52, 0x49, 0x46, 0x46]) && startsWith(body, [0x57, 0x45, 0x42, 0x50], 8))
    return "webp";
  return undefined;
}

/** One image at a time in the process, at most four waiting: an upload past that is answered busy at once. */
export type ImageGate = Readonly<{ run: <T>(work: () => Promise<T>) => Promise<T> }>;

export function createImageGate(running = RUNNING, waiting = WAITING): ImageGate {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active -= 1;
    queue.shift()?.();
  };
  return {
    run: async <T>(work: () => Promise<T>): Promise<T> => {
      if (active >= running) {
        if (queue.length >= waiting) throw new ImageError("busy");
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      active += 1;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

const processGate = createImageGate();

export type Reencoded = Readonly<{ body: Buffer; width: number; height: number }>;

/**
 * The stored form of an upload: turned upright from its EXIF orientation, at most 2,048 px on its long side, on white
 * where it was transparent, as a JPEG at quality 82 with no metadata (sharp writes none unless asked, so EXIF, GPS and
 * any profile go). A decode past 32 MP, a truncated file or a lying header is `photo_unreadable`.
 */
export async function reencode(upload: Buffer, gate: ImageGate = processGate): Promise<Reencoded> {
  if (sniff(upload) === undefined) throw new ImageError("photo_type");
  return gate.run(async () => {
    try {
      const { data, info } = await sharp(upload, {
        limitInputPixels: PIXELS_MAX,
        failOn: "error",
        sequentialRead: true,
      })
        .rotate()
        .resize(PHOTO_SIDE_MAX, PHOTO_SIDE_MAX, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer({ resolveWithObject: true });
      return { body: data, width: info.width, height: info.height };
    } catch {
      throw new ImageError("photo_unreadable");
    }
  });
}
