import { setZXingModuleOverrides } from "barcode-detector";

/**
 * Where the QR decoder's wasm is served from (ADR-245): our own origin, the file `apps/web` already hosts for the kiosk
 * page, with its version in the name so a long cache never serves a stale one. `expo-camera` reads QR codes in the browser
 * with `barcode-detector`, whose default is `fastly.jsdelivr.net`; the page's CSP (`connect-src 'self'`) would block that,
 * and a player's camera must not depend on a third party.
 */
export const ZXING_WASM_PATH = "/zxing/zxing_reader-3.1.6.wasm";

/** Points `barcode-detector` (the one `expo-camera` loads) at our wasm. Called once, before any camera opens. */
export function prepareCameraDecoder(): void {
  setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? ZXING_WASM_PATH : `${prefix}${path}`,
  });
}
