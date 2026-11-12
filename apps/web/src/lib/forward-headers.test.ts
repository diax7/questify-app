import { describe, expect, it } from "vitest";
import { forwardedResponseHeaders, imageLocation } from "#src/lib/forward-headers.ts";
import { forwardBodyBytes, forwardTimeoutMs, PHOTO_TIMEOUT_MS } from "#src/lib/forward-timeout.ts";

const EVENT = "11111111-2222-4333-8444-555555555555";
const IMAGE = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const BUCKET = "https://s3.riyadh-1.example.net";
const SIGNED = `${BUCKET}/bucket/o/x/e/y/logo/${IMAGE}.png?X-Amz-Expires=300`;
const PLAYER_READ = `/v1/events/${EVENT}/images/${IMAGE}`;
const TEAM_READ = `/v1/organizers/${EVENT}/events/${EVENT}/images/${IMAGE}`;

/** The forwarder's redirect guard (ADR-829): `location` passes only from the image reads, only to the photo bucket. */
describe("an image read's redirect", () => {
  it("passes the bucket's signed URL from both image read doors", () => {
    expect(imageLocation(PLAYER_READ, SIGNED, BUCKET)).toBe(SIGNED);
    expect(imageLocation(TEAM_READ, SIGNED, BUCKET)).toBe(SIGNED);
    const headers = forwardedResponseHeaders(
      new Headers({ location: SIGNED }),
      PLAYER_READ,
      BUCKET,
    );
    expect(headers.get("location")).toBe(SIGNED);
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("drops a location to any other host, scheme or look-alike, and on every other path", () => {
    for (const elsewhere of [
      "https://evil.example/x",
      "http://s3.riyadh-1.example.net/bucket/x",
      "https://s3.riyadh-1.example.net.evil.example/x",
      "https://s3.riyadh-1.example.net@evil.example/x",
      "//evil.example/x",
      "/v1/elsewhere",
      "not a url",
    ]) {
      expect(imageLocation(PLAYER_READ, elsewhere, BUCKET)).toBeUndefined();
    }
    expect(imageLocation(`/v1/events/${EVENT}/maps`, SIGNED, BUCKET)).toBeUndefined();
    expect(imageLocation(`${PLAYER_READ}/x`, SIGNED, BUCKET)).toBeUndefined();
    expect(imageLocation(PLAYER_READ, SIGNED, undefined)).toBeUndefined();
    expect(
      forwardedResponseHeaders(new Headers({ location: SIGNED }), "/v1/me", BUCKET).has("location"),
    ).toBe(false);
  });
});

describe("an organizer image upload", () => {
  it("gets the photo upload's 8 MB and 90 seconds", () => {
    const path = `/v1/organizers/${EVENT}/events/${EVENT}/images`;
    expect(forwardTimeoutMs(path)).toBe(PHOTO_TIMEOUT_MS);
    expect(forwardBodyBytes(path)).toBe(8 * 1024 * 1024);
    expect(forwardBodyBytes(`${path}/${IMAGE}`)).toBe(1_048_576);
  });
});
