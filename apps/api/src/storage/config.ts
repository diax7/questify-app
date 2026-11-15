/** The media database and its links (ADR-839, ADR-840): photos are stored in PostgreSQL in `riyadh-1`. */
export type StorageSettings = Readonly<{
  /** The runtime role's connection string (`questify_media_app`), never the owner's. */
  databaseUrl: string;
  /** The public origin that serves `/v1/media/*` (the API's own public host); https in production. */
  origin: string;
  /** The key the read links are signed with (32 characters or more). */
  urlSecret: string;
}>;

type Env = Readonly<Record<string, string | undefined>>;

export const STORAGE_NAMES = ["MEDIA_DATABASE_URL", "MEDIA_ORIGIN", "MEDIA_URL_SECRET"] as const;
/** The bucket settings of before T-814: no code reads them any more. */
export const RETIRED_S3_NAMES = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_URL_STYLE",
] as const;
const SECRET_MIN = 32;

const valueOf = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
};

function originOf(text: string, nodeEnv: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("MEDIA_ORIGIN must be a URL like https://api.example.com.");
  }
  if (url.protocol !== "https:" && (nodeEnv === "production" || url.protocol !== "http:")) {
    throw new Error("MEDIA_ORIGIN must start with https:// (http:// only outside production).");
  }
  if (!onlyOrigin(url)) {
    throw new Error("MEDIA_ORIGIN must be an origin only: no path, query or user.");
  }
  return url.origin;
}

const onlyOrigin = (url: URL): boolean =>
  url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";

function databaseUrlOf(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("MEDIA_DATABASE_URL must be a postgres:// connection string.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("MEDIA_DATABASE_URL must be a postgres:// connection string.");
  }
  return text;
}

/**
 * All three media settings or none (the Msegat pattern): without them photos are off, the builder keeps refusing photo
 * quests and the upload doors answer 503 `photos_off`. Nothing here is logged; the secret stays in memory.
 */
export function storageSettings(env: Env, nodeEnv: string): StorageSettings | undefined {
  const set = STORAGE_NAMES.filter((name) => valueOf(env, name) !== undefined);
  if (set.length === 0) {
    return undefined;
  }
  if (set.length !== STORAGE_NAMES.length) {
    throw new Error(
      `${STORAGE_NAMES.join(", ")} are required together: the media database's settings.`,
    );
  }
  const urlSecret = valueOf(env, "MEDIA_URL_SECRET") ?? "";
  if (urlSecret.length < SECRET_MIN) {
    throw new Error(`MEDIA_URL_SECRET must be at least ${SECRET_MIN} characters.`);
  }
  return {
    databaseUrl: databaseUrlOf(valueOf(env, "MEDIA_DATABASE_URL") ?? ""),
    origin: originOf(valueOf(env, "MEDIA_ORIGIN") ?? "", nodeEnv),
    urlSecret,
  };
}

/** Whether any retired S3 variable is still set (logged once at start; a forgotten secret never blocks a deploy). */
export const s3Ignored = (env: Env): boolean =>
  RETIRED_S3_NAMES.some((name) => valueOf(env, name) !== undefined);
