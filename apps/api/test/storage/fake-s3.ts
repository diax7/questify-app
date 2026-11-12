import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { StorageSettings } from "#src/storage/config";

/**
 * An in-process S3 double for unit and integration tests (no new CI service): PUT, GET, HEAD and DELETE on one
 * bucket, path-style. It checks SigV4 itself with node:crypto (never with aws4fetch, the library under test): a
 * signed header or a presigned query, the credential, the region, the payload hash and the expiry. Anything else is
 * 403, as a private bucket answers. It can be told to answer the next requests slowly, with an error status, or by
 * dropping the connection.
 */
export type FakeS3 = Readonly<{
  settings: StorageSettings;
  objects: Map<string, Readonly<{ body: Buffer; contentType: string }>>;
  /** Every request, in order: method, object key (or "" for the bucket) and the status answered. */
  log: { method: string; key: string; status: number }[];
  /** What the next requests do, one entry each, before anything else. */
  script: Behaviour[];
  /** The fake's clock in milliseconds; tests move it to expire a signed URL. */
  clock: { now: number };
  close: () => Promise<void>;
}>;

export type Behaviour =
  | Readonly<{ status: number }>
  | Readonly<{ drop: true }>
  | Readonly<{ delayMs: number }>;

const ALGORITHM = "AWS4-HMAC-SHA256";
const SKEW_MS = 15 * 60 * 1000;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, as SigV4 asks for: every byte but unreserved characters. */
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const canonicalPath = (pathname: string) =>
  decodeURIComponent(pathname).split("/").map(encode).join("/");

function canonicalQuery(url: URL, skip: string | undefined): string {
  return [...url.searchParams]
    .filter(([name]) => name !== skip)
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .toSorted(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

type Signed = Readonly<{
  credential: string;
  signedHeaders: string;
  signature: string;
  amzDate: string;
  payloadHash: string;
  presigned: boolean;
  expires: number | undefined;
}>;

function signedOf(request: IncomingMessage, url: URL): Signed | undefined {
  const auth = request.headers.authorization;
  if (typeof auth === "string") {
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
        auth,
      );
    if (match === null) return undefined;
    return {
      credential: match[1] ?? "",
      signedHeaders: match[2] ?? "",
      signature: match[3] ?? "",
      amzDate: String(request.headers["x-amz-date"] ?? ""),
      payloadHash: String(request.headers["x-amz-content-sha256"] ?? ""),
      presigned: false,
      expires: undefined,
    };
  }
  const query = url.searchParams;
  if (query.get("X-Amz-Algorithm") !== ALGORITHM) return undefined;
  return {
    credential: query.get("X-Amz-Credential") ?? "",
    signedHeaders: query.get("X-Amz-SignedHeaders") ?? "",
    signature: query.get("X-Amz-Signature") ?? "",
    amzDate: query.get("X-Amz-Date") ?? "",
    payloadHash: "UNSIGNED-PAYLOAD",
    presigned: true,
    expires: Number(query.get("X-Amz-Expires") ?? "0"),
  };
}

const dateOf = (amzDate: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (m === null) return Number.NaN;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
};

/** Why a request is refused, or undefined when its signature, scope and time hold. */
function refusalOf(
  settings: StorageSettings,
  request: IncomingMessage,
  url: URL,
  body: Buffer,
  now: number,
): string | undefined {
  const signed = signedOf(request, url);
  if (signed === undefined) return "unsigned";
  const [keyId, day, region, service, terminal] = signed.credential.split("/");
  if (keyId !== settings.accessKeyId) return "unknown_key";
  if (region !== settings.region || service !== "s3" || terminal !== "aws4_request") return "scope";
  const at = dateOf(signed.amzDate);
  if (!Number.isFinite(at) || signed.amzDate.slice(0, 8) !== day) return "date";
  if (signed.presigned) {
    if (signed.expires === undefined || !(signed.expires > 0) || signed.expires > 604_800)
      return "expires";
    if (now > at + signed.expires * 1000) return "expired";
    if (now < at - SKEW_MS) return "date";
  } else if (Math.abs(now - at) > SKEW_MS) {
    return "date";
  }
  if (
    !signed.presigned &&
    signed.payloadHash !== "UNSIGNED-PAYLOAD" &&
    signed.payloadHash !== sha256(body)
  ) {
    return "payload";
  }
  const names = signed.signedHeaders.split(";");
  if (!names.includes("host")) return "host";
  const headers = names
    .map(
      (name) =>
        `${name}:${String(request.headers[name] ?? "")
          .trim()
          .replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonical = [
    request.method ?? "",
    canonicalPath(url.pathname),
    canonicalQuery(url, signed.presigned ? "X-Amz-Signature" : undefined),
    headers,
    signed.signedHeaders,
    signed.payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = [ALGORITHM, signed.amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${settings.secretAccessKey}`, day ?? ""), region), "s3"),
    "aws4_request",
  );
  return createHmac("sha256", key).update(toSign).digest("hex") === signed.signature
    ? undefined
    : "signature";
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

export async function startFakeS3(
  options: Partial<
    Pick<StorageSettings, "bucket" | "region" | "accessKeyId" | "secretAccessKey">
  > = {},
): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const log: { method: string; key: string; status: number }[] = [];
  const script: Behaviour[] = [];
  const clock = { now: Date.now() };
  let settings: StorageSettings = {
    endpoint: "",
    bucket: options.bucket ?? "questify-media-test",
    region: options.region ?? "riyadh-1",
    accessKeyId: options.accessKeyId ?? "TESTKEYID",
    secretAccessKey: options.secretAccessKey ?? "test-secret-access-key",
    urlStyle: "path",
  };

  const answer = (
    response: ServerResponse,
    entry: { method: string; key: string },
    status: number,
    body?: Buffer,
    type?: string,
  ) => {
    log.push({ ...entry, status });
    response.writeHead(status, type === undefined ? {} : { "content-type": type });
    response.end(body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const body = await readBody(request);
    const prefix = `/${settings.bucket}/`;
    const key = url.pathname.startsWith(prefix)
      ? decodeURIComponent(url.pathname.slice(prefix.length))
      : "";
    const entry = { method: request.method ?? "", key };
    const next = script.shift();
    if (next !== undefined && "delayMs" in next)
      await new Promise((r) => setTimeout(r, next.delayMs));
    if (next !== undefined && "drop" in next) {
      log.push({ ...entry, status: 0 });
      request.socket.destroy();
      return;
    }
    if (next !== undefined && "status" in next) return answer(response, entry, next.status);
    if (refusalOf(settings, request, url, body, clock.now) !== undefined)
      return answer(response, entry, 403);
    if (key === "") return answer(response, entry, 403);
    const found = objects.get(key);
    if (request.method === "PUT") {
      objects.set(key, { body, contentType: String(request.headers["content-type"] ?? "") });
      return answer(response, entry, 200);
    }
    if (request.method === "DELETE") {
      if (found === undefined) return answer(response, entry, 404);
      objects.delete(key);
      return answer(response, entry, 204);
    }
    if (found === undefined) return answer(response, entry, 404);
    const type = url.searchParams.get("response-content-type") ?? found.contentType;
    return answer(response, entry, 200, request.method === "HEAD" ? undefined : found.body, type);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  settings = { ...settings, endpoint: `http://127.0.0.1:${port}` };
  return {
    settings,
    objects,
    log,
    script,
    clock,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
