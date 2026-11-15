import { describe, expect, it } from "vitest";
import { StorageError, type ObjectStore } from "#src/storage/client";
import type { Reencoded } from "#src/storage/images";
import { PhotoRefused, storeUpload, type Slot } from "#src/storage/upload";

const SLOT: Slot = { id: "slot-1", key: "o/a/e/b/submission/slot-1.jpg", stored: false };
const IMAGE = { body: Buffer.from("jpeg"), width: 1, height: 1 } as Reencoded;

/** One upload's steps with a store whose put fails as given; records the doors it called. */
function stepsWith(failure: Error | undefined) {
  const called: string[] = [];
  const storage = {
    put: async () => {
      called.push("put");
      if (failure !== undefined) throw failure;
    },
  } as unknown as ObjectStore;
  return {
    called,
    steps: {
      storage,
      reserve: async () => SLOT,
      release: async () => called.push("release"),
      encode: async () => IMAGE,
      stored: async () => {
        called.push("stored");
        return true;
      },
    },
  };
}

const refusalOf = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => (error as PhotoRefused).error,
  );

/** The shared upload (T-814, plan review 86 MINOR 3): what a failed put answers. */
describe("storeUpload", () => {
  it("gives the slot back and answers photo_send_again once, when the key already holds other bytes", async () => {
    const { steps, called } = stepsWith(new StorageError("put", "conflict"));
    const refused = await refusalOf(storeUpload(steps));
    expect([refused?.status, refused?.envelope.code]).toEqual([409, "photo_send_again"]);
    expect(called).toEqual(["put", "release"]);
  });

  it("keeps the slot and answers storage_unavailable when the media database did not answer", async () => {
    const { steps, called } = stepsWith(new StorageError("put", "unavailable"));
    const refused = await refusalOf(storeUpload(steps));
    expect([refused?.status, refused?.envelope.code]).toEqual([503, "storage_unavailable"]);
    expect(called).toEqual(["put"]);
  });

  it("marks the slot stored after a put", async () => {
    const { steps, called } = stepsWith(undefined);
    expect((await storeUpload(steps)).slot).toBe(SLOT);
    expect(called).toEqual(["put", "stored"]);
  });
});
