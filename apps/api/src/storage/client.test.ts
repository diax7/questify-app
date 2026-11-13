import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createObjectStore, StorageError, type ObjectStore } from "#src/storage/client";
import { startFakeS3, type FakeS3 } from "#test/storage/fake-s3";

const KEY =
  "o/11111111-1111-4111-8111-111111111111/e/22222222-2222-4222-8222-222222222222/submission/33333333-3333-4333-8333-333333333333.jpg";
const BODY = Buffer.from("jpeg bytes");

/** The S3 client (T-301b): SigV4 on every call, a timeout, two retries on what a retry can fix, and signed reads. */
describe("object store client", () => {
  let fake: FakeS3;
  let store: ObjectStore;
  const logged: Record<string, unknown>[] = [];

  beforeAll(async () => {
    fake = await startFakeS3();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    fake.script.length = 0;
    fake.log.length = 0;
    fake.objects.clear();
    fake.clock.now = Date.now();
    logged.length = 0;
    store = createObjectStore(fake.settings, {
      retryDelayMs: 1,
      timeoutMs: 300,
      log: (fields) => logged.push(fields),
    });
  });

  it("puts, signs a read the bucket serves, and deletes", async () => {
    await store.put(KEY, BODY);
    expect(fake.objects.get(KEY)).toEqual({ body: BODY, contentType: "image/jpeg" });
    const signed = await store.signGet(KEY, 300);
    expect(signed.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
    expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const url = new URL(signed.url);
    expect(url.origin).toBe(fake.settings.endpoint);
    expect(url.pathname).toBe(`/${fake.settings.bucket}/${KEY}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("response-content-type")).toBe("image/jpeg");
    expect(url.searchParams.get("response-content-disposition")).toBe("inline");
    const read = await fetch(signed.url);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(BODY);
    await store.delete(KEY);
    expect(fake.objects.has(KEY)).toBe(false);
  });

  it("is refused without a signature, with a wrong one, and after the signed URL expires", async () => {
    await store.put(KEY, BODY);
    expect((await fetch(`${fake.settings.endpoint}/${fake.settings.bucket}/${KEY}`)).status).toBe(
      403,
    );
    expect((await fetch(`${fake.settings.endpoint}/${fake.settings.bucket}/`)).status).toBe(403);
    const signed = await store.signGet(KEY, 300);
    // Flip the first hex digit (a fixed "0" left a signature that already began with 0 intact: a 1-in-16 flake).
    const tampered = signed.url.replace(
      /X-Amz-Signature=([0-9a-f])/,
      (_, digit: string) => `X-Amz-Signature=${digit === "0" ? "1" : "0"}`,
    );
    expect((await fetch(tampered)).status).toBe(403);
    const otherKey = new URL(signed.url);
    otherKey.pathname = otherKey.pathname.replace("submission", "ticket");
    expect((await fetch(otherKey)).status).toBe(403);
    fake.clock.now += 301_000;
    expect((await fetch(signed.url)).status).toBe(403);
    const wrong = createObjectStore(
      { ...fake.settings, secretAccessKey: "not-the-secret" },
      { retryDelayMs: 1 },
    );
    await expect(wrong.put(KEY, BODY)).rejects.toMatchObject({ status: 403 });
  });

  it("signs for at most the time asked, never longer than 5 minutes", async () => {
    await expect(store.signGet(KEY, 3600)).rejects.toThrow(/at most 300/);
    const short = new URL((await store.signGet(KEY, 60)).url);
    expect(short.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("retries twice on 5xx, 429 and a dropped connection, then fails with the last answer", async () => {
    fake.script.push({ status: 503 }, { status: 429 });
    await store.put(KEY, BODY);
    expect(fake.log.map((entry) => entry.status)).toEqual([503, 429, 200]);

    fake.log.length = 0;
    fake.script.push({ drop: true }, { status: 500 }, { status: 502 });
    const failed = await store.put(KEY, BODY).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(StorageError);
    expect(failed).toMatchObject({ code: "status", status: 502, op: "put" });
    expect(fake.log.map((entry) => entry.status)).toEqual([0, 500, 502]);
    expect(logged.at(-1)).toEqual({
      event: "storage.failed",
      op: "put",
      purpose: "submission",
      status: 502,
    });
    expect(JSON.stringify(logged)).not.toContain(KEY.slice(2, 38));
  });

  it("never retries a refusal such as 403", async () => {
    fake.script.push({ status: 403 });
    await expect(store.put(KEY, BODY)).rejects.toMatchObject({ code: "status", status: 403 });
    expect(fake.log).toHaveLength(1);
  });

  it("gives up on a call that outlives its timeout, after two more tries", async () => {
    fake.script.push({ delayMs: 600 }, { delayMs: 600 }, { delayMs: 600 });
    const started = Date.now();
    await expect(store.put(KEY, BODY)).rejects.toMatchObject({ code: "timeout", op: "put" });
    expect(Date.now() - started).toBeLessThan(1800);
  });

  it("counts a delete of an object that is gone as done", async () => {
    await store.delete(KEY);
    expect(fake.log).toEqual([{ method: "DELETE", key: KEY, status: 404 }]);
    fake.script.push({ status: 500 }, { status: 500 }, { status: 500 });
    await expect(store.delete(KEY)).rejects.toMatchObject({
      code: "status",
      status: 500,
      op: "delete",
    });
  });

  it("builds virtual-host URLs when asked", async () => {
    const virtual = createObjectStore({
      ...fake.settings,
      endpoint: "https://s3.riyadh-1.example.test",
      urlStyle: "virtual",
    });
    const url = new URL((await virtual.signGet(KEY, 300)).url);
    expect(url.host).toBe(`${fake.settings.bucket}.s3.riyadh-1.example.test`);
    expect(url.pathname).toBe(`/${KEY}`);
  });
});
