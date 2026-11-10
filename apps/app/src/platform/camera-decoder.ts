/** A phone reads QR codes with its own scanner, so there is no decoder to set up (the browser's is `camera-decoder.web.ts`). */
export function prepareCameraDecoder(): void {
  // Nothing to do on a phone.
}
