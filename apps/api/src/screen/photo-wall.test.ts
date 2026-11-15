import { describe, expect, it } from "vitest";
import { signedScene, signWall } from "#src/screen/photo-wall";
import { createSceneReader } from "#src/screen/scenes";
import type { ObjectStore } from "#src/storage/client";
import { createMediaStore } from "#src/storage/media-store";
import { WALL_URL_SECONDS, stableWallUrl } from "#src/storage/signed";
import { fakePool } from "#test/support/fake-pool";

const KEY =
  "o/11111111-1111-4111-8111-111111111111/e/22222222-2222-4222-8222-222222222222/submission/33333333-3333-4333-8333-333333333333.jpg";
const MEDIA = "33333333-3333-4333-8333-333333333333";
const store: ObjectStore = createMediaStore(fakePool(() => ({})).pool, {
  origin: "https://api.example.test",
  secret: "w".repeat(32),
});
const MINUTE = 60_000;
const at = (ms: number) => () => 1_800_000_000_000 - (1_800_000_000_000 % MINUTE) + ms;

/** The photo wall's signing (T-504b; plan section 7, M2 and M3): stable URLs, never a key, nothing without a bucket. */
describe("the photo wall's URLs", () => {
  it("answers one URL within a minute and a new one in the next, lasting at most 120 seconds", () => {
    const first = stableWallUrl(store, KEY, at(1_000));
    const second = stableWallUrl(store, KEY, at(59_000));
    const next = stableWallUrl(store, KEY, at(61_000));
    expect(second?.url).toBe(first?.url);
    expect(next?.url).not.toBe(first?.url);
    expect(Number(new URL(String(first?.url)).searchParams.get("e"))).toBe(
      at(0)() / 1000 + WALL_URL_SECONDS,
    );
    expect(first?.expiresAt.getTime()).toBe(at(0)() + WALL_URL_SECONDS * 1000);
    expect(stableWallUrl(undefined, KEY)).toBeNull();
  });

  it("drops each key, and leaves out every photo without a media store", () => {
    const rows = [{ mediaId: MEDIA, key: KEY }];
    const signed = signWall(store, rows, at(5_000));
    expect(signed).toHaveLength(1);
    expect(Object.keys(signed[0] ?? {}).toSorted()).toEqual(["expiresAt", "mediaId", "url"]);
    expect(JSON.stringify(signed)).not.toContain('"key"');
    expect(signWall(undefined, rows)).toEqual([]);
    expect(signedScene(undefined, { shut: null, photos: rows })).toEqual({
      shut: null,
      photos: [],
    });
    expect(signedScene(store, { shut: "event_ended" })).toEqual({ shut: "event_ended" });
  });

  it("signs the photo scene in the reader and passes other scenes as they are", async () => {
    const { pool, queries } = fakePool((sql) => ({
      rows: [
        {
          answer: sql.includes("screen_photos")
            ? { shut: null, photos: [{ mediaId: MEDIA, key: KEY }] }
            : { shut: null },
        },
      ],
    }));
    const reader = createSceneReader({ pool, storage: store }, at(2_000));
    const answer = await reader.read({ id: MEDIA, eventId: MEDIA }, "photo");
    expect(queries).toEqual(["SELECT screen_photos() AS answer"]);
    const photos = (answer as { photos: { mediaId: string; url: string; key?: string }[] }).photos;
    expect(photos[0]?.mediaId).toBe(MEDIA);
    expect(photos[0]?.key).toBeUndefined();
    expect(new URL(String(photos[0]?.url)).host).toBe("api.example.test");
    expect(await reader.read({ id: MEDIA, eventId: MEDIA }, "poll")).toEqual({ shut: null });
  });
});
