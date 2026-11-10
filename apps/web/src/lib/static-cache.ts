/**
 * How long a browser may keep the files of `public/`. Next sends them with `max-age=0`, so every page view asked for
 * each picture again (a 304 when unchanged; measured on staging, T-813 part 2). The decoder carries its version in its
 * name, so it never changes under that name; the art and icons keep their names, so they are kept a day and shown stale
 * for a week while the browser checks them. A picture that changes gets a new name.
 */
const ART = "public, max-age=86400, stale-while-revalidate=604800";
const VERSIONED = "public, max-age=31536000, immutable";

export type StaticRule = Readonly<{
  source: string;
  headers: ReadonlyArray<Readonly<{ key: string; value: string }>>;
}>;

export const STATIC_FILE_RULES: readonly StaticRule[] = [
  { source: "/zxing/:file*", headers: [{ key: "Cache-Control", value: VERSIONED }] },
  // The player web build (T-803 P3): Metro names its scripts, pictures and fonts by content hash, so they never change
  // under a name. `index.html` is not here: it is served at `/play` by the proxy's `no-store` page headers.
  { source: "/play/_expo/:file*", headers: [{ key: "Cache-Control", value: VERSIONED }] },
  { source: "/play/assets/:file*", headers: [{ key: "Cache-Control", value: VERSIONED }] },
  {
    // Only a file name with an extension of the shipped art: the bare folder is not matched.
    source: "/:folder(avatars|currency|souvenirs|brand)/:file.:ext(webp|png)",
    headers: [{ key: "Cache-Control", value: ART }],
  },
  { source: "/favicon.ico", headers: [{ key: "Cache-Control", value: ART }] },
];
