import { encode } from "uqr";

/** Four light modules around the code: what scanners need to find its edge (ISO/IEC 18004). */
export const QUIET_ZONE = 4;

/** A QR code as one SVG path of dark 1×1 squares, on a square of `size` modules (quiet zone included). */
export type QrDrawing = Readonly<{ size: number; path: string }>;

/**
 * Draws a code for `text` with error correction M (a 15% damaged print still scans). The path is plain data, never
 * markup, so the page never injects HTML.
 */
export function qrDrawing(text: string): QrDrawing {
  const { data, size } = encode(text, { ecc: "M", border: QUIET_ZONE });
  const squares: string[] = [];
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) {
        squares.push(`M${x} ${y}h1v1h-1z`);
      }
    });
  });
  return { size, path: squares.join("") };
}

/** A standalone SVG file of the code, black on white, for "Download". */
export function qrSvgFile(text: string): string {
  const { size, path } = qrDrawing(text);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  );
}
