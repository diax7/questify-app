import { describe, expect, it, vi } from "vitest";
import {
  createRecapSharer,
  type ImageShareModules,
  type RecapShareDeps,
} from "#src/event/recap-share.ts";

const TEXTS = { message: "My recap from Najd Meetup", dialogTitle: "Share your recap" };
const CARD = { current: "the card" };

function fakes(present: boolean) {
  const order: string[] = [];
  let captures = 0;
  const modules: ImageShareModules = {
    captureRef: vi.fn(async () => {
      captures += 1;
      order.push(`capture ${captures}`);
      return `file:///cache/recap-${captures}.png`;
    }),
    releaseCapture: vi.fn((uri: string) => {
      order.push(`release ${uri}`);
    }),
    shareAsync: vi.fn(async (uri: string) => {
      order.push(`share ${uri}`);
    }),
  };
  const deps = {
    modulesPresent: vi.fn(() => present),
    loadModules: vi.fn(() => modules),
    shareText: vi.fn(async () => ({ action: "sharedAction" })),
  } satisfies RecapShareDeps;
  return { deps, modules, order };
}

describe("the recap share without the native modules", () => {
  it("shares the fixed text line and never loads either package", async () => {
    const { deps, modules } = fakes(false);
    const sharer = createRecapSharer(deps);
    expect(await sharer.share(CARD, TEXTS)).toBe("text");
    expect(deps.shareText).toHaveBeenCalledExactlyOnceWith("My recap from Najd Meetup");
    expect(deps.loadModules).not.toHaveBeenCalled();
    expect(modules.captureRef).not.toHaveBeenCalled();
    expect(modules.shareAsync).not.toHaveBeenCalled();
  });

  it("checks again on each share, so a build that gains the modules is not stuck on text", async () => {
    const { deps } = fakes(false);
    const sharer = createRecapSharer(deps);
    await sharer.share(CARD, TEXTS);
    await sharer.share(CARD, TEXTS);
    expect(deps.modulesPresent).toHaveBeenCalledTimes(2);
    expect(deps.shareText).toHaveBeenCalledTimes(2);
  });

  it("falls back to the text line when the packages are there but fail to load", async () => {
    const { deps } = fakes(true);
    deps.loadModules.mockImplementation(() => {
      throw new Error("Cannot find native module 'RNViewShot'");
    });
    expect(await createRecapSharer(deps).share(CARD, TEXTS)).toBe("text");
    expect(deps.shareText).toHaveBeenCalledOnce();
  });

  it("has nothing to release", () => {
    const { deps, modules } = fakes(false);
    const sharer = createRecapSharer(deps);
    sharer.release();
    expect(modules.releaseCapture).not.toHaveBeenCalled();
  });

  it("surfaces a failed text share", async () => {
    const { deps } = fakes(false);
    deps.shareText.mockRejectedValue(new Error("no share sheet"));
    await expect(createRecapSharer(deps).share(CARD, TEXTS)).rejects.toThrow("no share sheet");
  });
});

describe("the recap share as an image", () => {
  it("captures the card as a PNG file and opens the share sheet with the image alone", async () => {
    const { deps, modules } = fakes(true);
    expect(await createRecapSharer(deps).share(CARD, TEXTS)).toBe("image");
    expect(modules.captureRef).toHaveBeenCalledExactlyOnceWith(CARD, {
      format: "png",
      quality: 1,
      result: "tmpfile",
    });
    expect(modules.shareAsync).toHaveBeenCalledExactlyOnceWith("file:///cache/recap-1.png", {
      mimeType: "image/png",
      UTI: "public.png",
      dialogTitle: "Share your recap",
    });
    expect(deps.shareText).not.toHaveBeenCalled();
  });

  it("sends no message, link or tracking with the image", async () => {
    const { deps, modules } = fakes(true);
    await createRecapSharer(deps).share(CARD, TEXTS);
    const options = vi.mocked(modules.shareAsync).mock.calls[0]?.[1];
    expect(Object.keys(options ?? {}).sort()).toEqual(["UTI", "dialogTitle", "mimeType"]);
    expect(JSON.stringify(vi.mocked(modules.shareAsync).mock.calls)).not.toMatch(
      /http|utm|recap from/i,
    );
  });

  it("keeps the capture after the sheet returns, because the other app may still be reading it", async () => {
    const { deps, modules } = fakes(true);
    await createRecapSharer(deps).share(CARD, TEXTS);
    expect(modules.releaseCapture).not.toHaveBeenCalled();
  });

  it("releases the previous capture before the next one is made", async () => {
    const { deps, order } = fakes(true);
    const sharer = createRecapSharer(deps);
    await sharer.share(CARD, TEXTS);
    await sharer.share(CARD, TEXTS);
    expect(order).toEqual([
      "capture 1",
      "share file:///cache/recap-1.png",
      "release file:///cache/recap-1.png",
      "capture 2",
      "share file:///cache/recap-2.png",
    ]);
  });

  it("releases the last capture when the screen closes, once", async () => {
    const { deps, modules } = fakes(true);
    const sharer = createRecapSharer(deps);
    await sharer.share(CARD, TEXTS);
    sharer.release();
    sharer.release();
    expect(modules.releaseCapture).toHaveBeenCalledExactlyOnceWith("file:///cache/recap-1.png");
  });

  it("loads the packages once, however many times the card is shared", async () => {
    const { deps } = fakes(true);
    const sharer = createRecapSharer(deps);
    await sharer.share(CARD, TEXTS);
    await sharer.share(CARD, TEXTS);
    await sharer.share(CARD, TEXTS);
    expect(deps.loadModules).toHaveBeenCalledOnce();
  });

  it("surfaces a failed capture without sharing, and a failed share sheet", async () => {
    const failing = fakes(true);
    vi.mocked(failing.modules.captureRef).mockRejectedValueOnce(new Error("view gone"));
    await expect(createRecapSharer(failing.deps).share(CARD, TEXTS)).rejects.toThrow("view gone");
    expect(failing.modules.shareAsync).not.toHaveBeenCalled();
    expect(failing.deps.shareText).not.toHaveBeenCalled();

    const busy = fakes(true);
    vi.mocked(busy.modules.shareAsync).mockRejectedValueOnce(new Error("sharing in progress"));
    const sharer = createRecapSharer(busy.deps);
    await expect(sharer.share(CARD, TEXTS)).rejects.toThrow("sharing in progress");
    sharer.release();
    expect(busy.modules.releaseCapture).toHaveBeenCalledOnce();
  });

  it("does not release a capture that never finished", async () => {
    const { deps, modules } = fakes(true);
    vi.mocked(modules.captureRef).mockRejectedValueOnce(new Error("view gone"));
    const sharer = createRecapSharer(deps);
    await expect(sharer.share(CARD, TEXTS)).rejects.toThrow();
    sharer.release();
    expect(modules.releaseCapture).not.toHaveBeenCalled();
  });
});
