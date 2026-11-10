/**
 * What each platform the player app runs on offers (T-803, FR-1816). A pure table: no import of a native module, so it
 * runs in tests and decides what a screen shows before anything native is touched. The browser is a phone browser; there
 * is no desktop layout.
 */
export type PlatformName = "ios" | "android" | "web";

export type Capabilities = Readonly<{
  /** Reading a QR code with the camera (on the web: `getUserMedia`, HTTPS only, decoded with the self-hosted zxing wasm). */
  cameraQr: boolean;
  /** Reading an NFC tag. Web NFC is Chrome on Android only, and is not used. */
  nfc: boolean;
  /** Where a location quest reads the position: the phone's service, or the browser's `navigator.geolocation`. */
  location: "native" | "browser";
  /** A short vibration on a tap, a scan or a win. The browser has none, so the wrapper does nothing there. */
  haptics: boolean;
  /** A system push notification. The in-app notification centre exists everywhere. */
  push: boolean;
  /** Capturing a card as an image and handing it to the share sheet (the recap card). */
  imageShare: boolean;
  /** The staff screens (stations, desk, NFC writing, pairing): a phone job, hidden in the browser. */
  operatorTools: boolean;
  /** How the player's own data file is handed over: the system share sheet, or a download from the browser. */
  dataExport: "share_sheet" | "download";
}>;

export const CAPABILITIES: Readonly<Record<PlatformName, Capabilities>> = {
  ios: {
    cameraQr: true,
    nfc: true,
    location: "native",
    haptics: true,
    push: true,
    imageShare: true,
    operatorTools: true,
    dataExport: "share_sheet",
  },
  android: {
    cameraQr: true,
    nfc: true,
    location: "native",
    haptics: true,
    push: true,
    imageShare: true,
    operatorTools: true,
    dataExport: "share_sheet",
  },
  web: {
    cameraQr: true,
    nfc: false,
    location: "browser",
    haptics: false,
    push: false,
    imageShare: false,
    operatorTools: false,
    dataExport: "download",
  },
};

/** The platform for a `Platform.OS` value. Anything that is not iOS or Android gets the web's smaller set. */
export function platformOf(os: string): PlatformName {
  return os === "ios" || os === "android" ? os : "web";
}
