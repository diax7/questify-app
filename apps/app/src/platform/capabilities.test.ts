import { describe, expect, it } from "vitest";
import { CAPABILITIES, platformOf } from "#src/platform/capabilities.ts";

describe("what each platform offers", () => {
  it("gives the iPhone and the Android phone everything", () => {
    const phone = {
      cameraQr: true,
      nfc: true,
      location: "native",
      haptics: true,
      push: true,
      imageShare: true,
      operatorTools: true,
      dataExport: "share_sheet",
    };
    expect(CAPABILITIES.ios).toEqual(phone);
    expect(CAPABILITIES.android).toEqual(phone);
  });

  it("gives the browser the camera and the browser's own location, but no NFC, haptics, push or image share", () => {
    expect(CAPABILITIES.web).toEqual({
      cameraQr: true,
      nfc: false,
      location: "browser",
      haptics: false,
      push: false,
      imageShare: false,
      operatorTools: false,
      dataExport: "download",
    });
  });
});

describe("platformOf", () => {
  it("names the two phones and treats anything else as the web", () => {
    expect(platformOf("ios")).toBe("ios");
    expect(platformOf("android")).toBe("android");
    expect(platformOf("web")).toBe("web");
    expect(platformOf("windows")).toBe("web");
    expect(platformOf("macos")).toBe("web");
    expect(platformOf("")).toBe("web");
  });
});
