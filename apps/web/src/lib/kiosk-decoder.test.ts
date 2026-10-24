import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import {
  ZXING_WASM_SHA256,
  ZXING_WASM_VERSION,
  prepareZXingModule,
  readBarcodes,
} from "zxing-wasm/reader";
import { ZXING_WASM_PATH } from "#src/lib/kiosk.ts";

const WEB_ROOT = join(import.meta.dirname, "..", "..");
const committed = () => readFile(join(WEB_ROOT, "public", ...ZXING_WASM_PATH.split("/")));
const installed = () =>
  readFile(
    createRequire(join(WEB_ROOT, "package.json")).resolve("zxing-wasm/reader/zxing_reader.wasm"),
  );
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A QR of `text` as an RGBA image, `scale` pixels a module, the shape `readBarcodes` takes for a frame. */
function qrImage(text: string, scale: number) {
  const { data, size } = encode(text, { ecc: "M", border: 4 });
  const side = size * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) {
        return;
      }
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const at = ((y * scale + dy) * side + x * scale + dx) * 4;
          pixels.fill(0, at, at + 3);
        }
      }
    });
  });
  return { data: pixels, width: side, height: side, colorSpace: "srgb" as const };
}

/**
 * The kiosk's decoder (T-309b, ADR-245): the committed wasm is the installed package's own file of the version its name
 * says (a bump that forgets the copy fails here), and it reads back a code of a live code's shape drawn as a QR.
 */
describe("the kiosk's decoder", () => {
  it("commits the installed package's wasm, named for its version", async () => {
    const file = await committed();
    expect(ZXING_WASM_PATH).toBe(`/zxing/zxing_reader-${ZXING_WASM_VERSION}.wasm`);
    expect(sha256(file)).toBe(sha256(await installed()));
    expect(sha256(file)).toBe(ZXING_WASM_SHA256);
  });

  it("reads a code shaped as a live code (50 base64url characters) back from a frame", async () => {
    const wasm = await committed();
    prepareZXingModule({
      overrides: {
        wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
      },
      fireImmediately: true,
    });
    const code = "CMW8yfLvTd-0kPm7Hj2ZsAbCdEfGhIjKlMnOpQrStUvWxYz0_1";
    const results = await readBarcodes(qrImage(code, 6), {
      formats: ["QRCode"],
      maxNumberOfSymbols: 1,
    });
    expect(results.map((result) => result.text)).toEqual([code]);
  });
});
