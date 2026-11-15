import { Pool } from "pg";
import { mediaPoolOptions } from "#src/db/pool-options";
import type { ObjectStore } from "#src/storage/client";
import { createMediaStore } from "#src/storage/media-store";
import { createMediaTestDatabase, type MediaTestDatabase } from "#test/support/test-db";

/** The origin test links are signed for; a test reads a link through `app.inject` with its path and query only. */
export const TEST_MEDIA_ORIGIN = "https://media.questify.test";
export const TEST_MEDIA_SECRET = "test-only-media-url-secret-0123456789";

export type MediaFixture = Readonly<{
  media: MediaTestDatabase;
  pool: Pool;
  store: ObjectStore;
  /** Every key the media database holds now (read as its owner). */
  keys: () => Promise<string[]>;
  /** One key's stored row, as its owner sees it. */
  row: (key: string) => Promise<{ content_type: string; body: Buffer } | undefined>;
  close: () => Promise<void>;
}>;

/** A media test database with the real store over the media role's pool (T-814): the S3 fake's successor. */
export async function startMediaFixture(): Promise<MediaFixture> {
  const media = await createMediaTestDatabase();
  const pool = new Pool({ ...mediaPoolOptions(media.appUrl), max: 3 });
  const store = createMediaStore(pool, { origin: TEST_MEDIA_ORIGIN, secret: TEST_MEDIA_SECRET });
  return {
    media,
    pool,
    store,
    keys: async () =>
      (
        await media.owner.query<{ key: string }>("SELECT key FROM media_blob ORDER BY key")
      ).rows.map((row) => row.key),
    row: async (key) =>
      (
        await media.owner.query<{ content_type: string; body: Buffer }>(
          "SELECT content_type, body FROM media_blob WHERE key = $1",
          [key],
        )
      ).rows[0],
    close: async () => {
      await pool.end();
      await media.close();
    },
  };
}

/** The path and query of a signed link, for `app.inject`. */
export const linkPath = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};
