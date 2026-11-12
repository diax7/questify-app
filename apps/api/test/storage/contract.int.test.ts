import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createObjectStore } from "#src/storage/client";
import { storageSettings } from "#src/storage/config";

/**
 * The bucket contract (T-301b, plan section 5): run by hand against a real bucket, never in CI, with
 * `S3_CONTRACT=1` and the five `S3_*` variables of that environment (RUNBOOK "Photo storage"). It writes and deletes its
 * own keys under `o/contract/…` only. What it proves: SigV4 with this region string, path-style (or virtual-host) URLs,
 * presigned reads, a private bucket (unsigned reads and lists refused), an 8 MB body, and deletes.
 */
const settings =
  process.env["S3_CONTRACT"] === "1" ? storageSettings(process.env, "test") : undefined;
const key = (name: string) => `o/contract/e/${randomUUID()}/submission/${name}.jpg`;

describe.skipIf(settings === undefined)("the photo bucket's contract (S3_CONTRACT=1)", () => {
  const store = createObjectStore(settings ?? ({} as never));

  const base = () => (settings?.urlStyle === "virtual" ? "" : `/${settings?.bucket}`);
  const unsigned = (path: string) => {
    const origin = new URL(settings?.endpoint ?? "http://invalid");
    const host =
      settings?.urlStyle === "virtual" ? `${settings.bucket}.${origin.host}` : origin.host;
    return fetch(`${origin.protocol}//${host}${base()}${path}`, { redirect: "error" });
  };

  it("puts, reads through a signed URL only, and deletes", async () => {
    const small = key("small");
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await store.put(small, body);
    const signed = await store.signGet(small, 60);
    const read = await fetch(signed.url, { redirect: "error" });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(body);
    expect((await unsigned(`/${small}`)).status).toBe(403);
    await store.delete(small);
    expect((await fetch(signed.url, { redirect: "error" })).ok).toBe(false);
    await store.delete(small);
  });

  it("refuses an unsigned list of the bucket", async () => {
    expect((await unsigned("/")).status).toBe(403);
  });

  it("takes an 8 MB body", async () => {
    const big = key("big");
    await store.put(big, Buffer.alloc(8 * 1024 * 1024, 0xff));
    await store.delete(big);
  });
});
