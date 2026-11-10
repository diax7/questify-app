import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataModulesPresent, loadDataModules } from "#src/account/data-export-native.web.ts";
import { canShareRecap, recapShareDeps } from "#src/event/recap-share-native.web.ts";
import {
  DIRECTION_KEY,
  applyDirectionForNextLaunch,
  layoutIsRtl,
  restartApp,
  setDocumentDirection,
} from "#src/i18n/native.web.ts";
import { nfcModule, readTag, stopReading, writeTag } from "#src/nfc/native.web.ts";
import { ZXING_WASM_PATH } from "#src/platform/camera-decoder.web.ts";
import { impactAsync, notificationAsync } from "#src/platform/haptics.web.ts";
import { myQrStore } from "#src/platform/my-qr-store.web.ts";
import { pushEvents, pushNative } from "#src/push/push-native.web.ts";

// `expo-localization` loads React Native, which only a bundler can read.
vi.mock("expo-localization", () => ({ getLocales: () => [] }));

afterEach(() => vi.unstubAllGlobals());

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A page with an `<html>` element and a local storage, as the browser gives them. */
const page = () => {
  const html = { dir: "", lang: "" };
  const store = new Map<string, string>();
  vi.stubGlobal("document", { documentElement: html });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  return { html, store };
};

describe("the web build's no-ops", () => {
  it("haptics do nothing and settle", async () => {
    await expect(impactAsync("light")).resolves.toBeUndefined();
    await expect(notificationAsync("success")).resolves.toBeUndefined();
  });

  it("push is unavailable and keeps every listener quiet", async () => {
    expect(pushNative.available()).toBe(false);
    expect(await pushNative.permission()).toBe("denied");
    expect(await pushNative.ask()).toBe("denied");
    await expect(pushNative.deviceToken()).rejects.toThrow("Push is not available in the browser.");
    expect(pushEvents.lastResponse()).toBeNull();
    const stop = pushEvents.onToken(() => undefined);
    expect(stop()).toBeUndefined();
  });

  it("NFC is not there", async () => {
    expect(await nfcModule()).toBeNull();
    expect(await readTag("Hold near the tag")).toEqual({ kind: "unsupported" });
    expect(await writeTag({})).toEqual({ kind: "unsupported" });
    await expect(stopReading()).resolves.toBeUndefined();
  });

  it("My QR is kept in memory", async () => {
    expect(await myQrStore.read()).toBeNull();
    await myQrStore.write("token-1");
    expect(await myQrStore.read()).toBe("token-1");
  });
});

describe("the recap share on the web", () => {
  it("never loads the image modules, and hides Share where the browser cannot share", () => {
    expect(recapShareDeps.modulesPresent()).toBe(false);
    expect(() => recapShareDeps.loadModules()).toThrow("not part of the web build");
    vi.stubGlobal("navigator", {});
    expect(canShareRecap()).toBe(false);
    vi.stubGlobal("navigator", { share: async () => undefined });
    expect(canShareRecap()).toBe(true);
  });

  it("shares the fixed text line with navigator.share", async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { share });
    await recapShareDeps.shareText("My recap");
    expect(share).toHaveBeenCalledExactlyOnceWith({ text: "My recap" });
  });
});

describe("the data download on the web", () => {
  it("needs a Blob, object URLs and a document", () => {
    vi.stubGlobal("document", undefined);
    expect(dataModulesPresent()).toBe(false);
    vi.stubGlobal("document", {});
    expect(dataModulesPresent()).toBe(true);
  });

  it("saves the text as a named download and revokes its URL afterwards", async () => {
    vi.useFakeTimers();
    const link = {
      href: "",
      download: "",
      click: vi.fn(),
      remove: vi.fn(),
      style: { display: "" },
    };
    const appended: unknown[] = [];
    vi.stubGlobal("document", {
      createElement: () => link,
      body: { appendChild: (node: unknown) => appended.push(node) },
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const modules = loadDataModules();
    const uri = modules.writeCacheFile("questify-data-2026-11-10.json", '{"a":1}');
    expect(uri.startsWith("blob:")).toBe(true);
    await modules.share(uri);
    expect(link.href).toBe(uri);
    expect(link.download).toBe("questify-data-2026-11-10.json");
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalledTimes(1);
    expect(appended).toEqual([link]);
    modules.remove(uri);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(uri);
    vi.useRealTimers();
    revoke.mockRestore();
  });
});

describe("the page's direction on the web", () => {
  it("sets dir and lang on <html>: Arabic right to left, English left to right", () => {
    const { html } = page();
    setDocumentDirection("ar");
    expect(html).toEqual({ dir: "rtl", lang: "ar" });
    expect(layoutIsRtl()).toBe(true);
    setDocumentDirection("en");
    expect(html).toEqual({ dir: "ltr", lang: "en" });
    expect(layoutIsRtl()).toBe(false);
  });

  it("remembers the language for the next page load and applies it now", () => {
    const { html, store } = page();
    applyDirectionForNextLaunch("ar");
    expect(store.get(DIRECTION_KEY)).toBe("ar");
    expect(html).toEqual({ dir: "rtl", lang: "ar" });
  });

  it("reloads the page to restart, and never settles", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    let settled = false;
    void restartApp().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });
});

describe("the camera decoder's wasm", () => {
  it("is served from our own origin, the file apps/web already hosts for the kiosk", () => {
    const web = join(import.meta.dirname, "..", "..", "..", "web");
    expect(ZXING_WASM_PATH).toBe("/zxing/zxing_reader-3.1.6.wasm");
    expect(readFileSync(join(web, "src", "lib", "kiosk.ts"), "utf8")).toContain(
      `ZXING_WASM_PATH = "${ZXING_WASM_PATH}"`,
    );
    const packaged = createRequire(join(web, "package.json")).resolve(
      "zxing-wasm/reader/zxing_reader.wasm",
    );
    expect(sha256(join(web, "public", ZXING_WASM_PATH))).toBe(sha256(packaged));
  });

  it("is the version the app's barcode-detector loads", () => {
    const manifestPath = join(
      import.meta.dirname,
      "..",
      "..",
      "node_modules",
      "barcode-detector",
      "package.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["zxing-wasm"]).toBe("3.1.6");
  });
});
