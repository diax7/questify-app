import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createImageGate, ImageError, reencode, reencodeFor, sniff } from "#src/storage/images";

const solid = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({
    create: {
      width,
      height,
      channels,
      background: channels === 4 ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 200, g: 30, b: 30 },
    },
  });

const refusedAs = async (work: Promise<unknown>) =>
  work.then(
    () => "none",
    (error: unknown) => (error instanceof ImageError ? error.kind : String(error)),
  );

/** The re-encoder (T-301b, Q-150, Q-151): what is stored is an upright JPEG, at most 2,048 px, with no metadata. */
describe("reencode", () => {
  it("drops EXIF and GPS from a JPEG", async () => {
    const tagged = await solid(64, 48)
      .withExif({
        IFD0: { Make: "QuestifyCam", Copyright: "Sara" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "24/1 42/1 0/1" },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const out = await reencode(tagged);
    const meta = await sharp(out.body).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(out.body.includes(Buffer.from("QuestifyCam"))).toBe(false);
    expect(out.body.includes(Buffer.from("Sara"))).toBe(false);
  });

  it("turns a photo upright from its orientation tag (6: rotated 90 degrees)", async () => {
    const sideways = await solid(200, 100).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await reencode(sideways);
    expect([out.width, out.height]).toEqual([100, 200]);
    expect((await sharp(out.body).metadata()).orientation).toBeUndefined();
  });

  it("brings 8,000 px down to 2,048 on the long side and never enlarges", async () => {
    const big = await solid(8000, 3000).jpeg({ quality: 50 }).toBuffer();
    expect(await reencode(big)).toMatchObject({ width: 2048, height: 768 });
    const small = await solid(300, 200).png().toBuffer();
    expect(await reencode(small)).toMatchObject({ width: 300, height: 200 });
  });

  it("flattens a transparent PNG and a WebP on white", async () => {
    const clear = await solid(20, 20, 4).png().toBuffer();
    const out = await reencode(clear);
    const { data } = await sharp(out.body).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every((value) => value > 245)).toBe(true);
    expect((await sharp(out.body).metadata()).hasAlpha).toBe(false);
    const webp = await solid(30, 10).webp().toBuffer();
    expect(await reencode(webp)).toMatchObject({ width: 30, height: 10 });
  });

  it("refuses HEIC and other files by their bytes, whatever they are called (415)", async () => {
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftypheic"),
      Buffer.alloc(32),
    ]);
    expect(sniff(heic)).toBeUndefined();
    expect(await refusedAs(reencode(heic))).toBe("photo_type");
    const zip = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(64)]);
    expect(await refusedAs(reencode(zip))).toBe("photo_type");
    expect(
      await refusedAs(reencode(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))),
    ).toBe("photo_type");
  });

  it("refuses a decompression bomb past 32 MP and a truncated file (422)", async () => {
    const bomb = await solid(8000, 4001).png({ compressionLevel: 9 }).toBuffer();
    expect(await refusedAs(reencode(bomb))).toBe("photo_unreadable");
    const real = await solid(400, 400).jpeg().toBuffer();
    expect(await refusedAs(reencode(real.subarray(0, 200)))).toBe("photo_unreadable");
  });

  it("runs one image at a time with four waiting, and answers busy beyond that", async () => {
    const gate = createImageGate();
    const first: { release?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      first.release = resolve;
    });
    const release = () => first.release?.();
    const order: number[] = [];
    const jobs = [0, 1, 2, 3, 4].map((n) =>
      gate.run(async () => {
        order.push(n);
        if (n === 0) await held;
      }),
    );
    expect(await refusedAs(gate.run(async () => undefined))).toBe("busy");
    release();
    await Promise.all(jobs);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(await refusedAs(gate.run(async () => undefined))).toBe("none");
  });
});

/** Organizer images (ADR-829 (1)): each kind's format and long side, with the same strip as a photo. */
describe("reencodeFor", () => {
  it("keeps a logo's transparency as a PNG of at most 512 px", async () => {
    const clear = await solid(1200, 600, 4).png().toBuffer();
    const stored = await reencodeFor("logo", clear);
    const meta = await sharp(stored.body).metadata();
    expect(sniff(stored.body)).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect([stored.width, stored.height]).toEqual([512, 256]);
    const { data } = await sharp(stored.body).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
  });

  it("stores an icon from a JPEG as a PNG and drops its EXIF", async () => {
    const tagged = await solid(64, 64)
      .withExif({ IFD0: { Make: "QuestifyCam" } })
      .jpeg()
      .toBuffer();
    const stored = await reencodeFor("icon", tagged);
    const meta = await sharp(stored.body).metadata();
    expect(meta.format).toBe("png");
    expect(meta.exif).toBeUndefined();
  });

  it("stores a picture as a JPEG of at most 1,600 px and a banner or map at most 2,048 px", async () => {
    const big = await solid(3000, 1500).png().toBuffer();
    const picture = await reencodeFor("picture", big);
    expect(sniff(picture.body)).toBe("jpeg");
    expect([picture.width, picture.height]).toEqual([1600, 800]);
    expect((await reencodeFor("banner", big)).width).toBe(2048);
    expect((await reencodeFor("map", big)).width).toBe(2048);
  });

  it("refuses what is not an image before any work", async () => {
    expect(await refusedAs(reencodeFor("logo", Buffer.from("GIF89a")))).toBe("photo_type");
  });
});
