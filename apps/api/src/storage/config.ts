/** The private bucket that holds photos (ADR-183): CranL's S3-compatible storage in `riyadh-1`. */
export type StorageSettings = Readonly<{
  /** The S3 endpoint's origin, like https://s3.riyadh-1.cranl.net; https in production. */
  endpoint: string;
  bucket: string;
  /** The region string the bucket signs with (SigV4). */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (`<endpoint>/<bucket>/<key>`) unless S3_URL_STYLE=virtual (`<bucket>.<host>/<key>`). */
  urlStyle: "path" | "virtual";
}>;

type Env = Readonly<Record<string, string | undefined>>;

export const STORAGE_NAMES = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,40}$/;

const valueOf = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
};

function endpointOf(text: string, nodeEnv: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("S3_ENDPOINT must be a URL like https://s3.example.com.");
  }
  if (url.protocol !== "https:" && (nodeEnv === "production" || url.protocol !== "http:")) {
    throw new Error("S3_ENDPOINT must start with https:// (http:// only outside production).");
  }
  if (url.pathname !== "/" || url.search !== "" || url.username !== "") {
    throw new Error("S3_ENDPOINT must be an origin only: no path, query or user.");
  }
  return url.origin;
}

/** The bucket's name and region, each checked. */
function placeOf(env: Env): Pick<StorageSettings, "bucket" | "region"> {
  const bucket = valueOf(env, "S3_BUCKET") ?? "";
  if (!BUCKET.test(bucket)) {
    throw new Error("S3_BUCKET must be a bucket name: lowercase letters, digits, dots and dashes.");
  }
  const region = valueOf(env, "S3_REGION") ?? "";
  if (!REGION.test(region)) {
    throw new Error("S3_REGION must be a region name like riyadh-1.");
  }
  return { bucket, region };
}

function styleOf(env: Env): StorageSettings["urlStyle"] {
  const style = valueOf(env, "S3_URL_STYLE") ?? "path";
  if (style !== "path" && style !== "virtual") {
    throw new Error('S3_URL_STYLE must be "path" or "virtual".');
  }
  return style;
}

/**
 * All five S3 variables or none (the Msegat pattern): without them photos are off, the builder keeps refusing photo
 * quests and the upload doors answer 503 `storage_off`. Nothing here is logged; the keys stay in memory.
 */
export function storageSettings(env: Env, nodeEnv: string): StorageSettings | undefined {
  const set = STORAGE_NAMES.filter((name) => valueOf(env, name) !== undefined);
  if (set.length === 0) {
    return undefined;
  }
  if (set.length !== STORAGE_NAMES.length) {
    throw new Error(
      `${STORAGE_NAMES.join(", ")} are required together: the photo bucket's settings.`,
    );
  }
  return {
    endpoint: endpointOf(valueOf(env, "S3_ENDPOINT") ?? "", nodeEnv),
    ...placeOf(env),
    accessKeyId: valueOf(env, "S3_ACCESS_KEY_ID") ?? "",
    secretAccessKey: valueOf(env, "S3_SECRET_ACCESS_KEY") ?? "",
    urlStyle: styleOf(env),
  };
}
