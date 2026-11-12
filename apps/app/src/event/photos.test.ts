import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import {
  acceptsOf,
  canSendPhoto,
  photoTypeOf,
  pickLine,
  questPhotoPath,
  ticketPhotoPath,
  uploadAnswer,
  uploadPhoto,
} from "#src/event/photos.ts";
import { sendSubmission } from "#src/event/submissions.ts";

const PHOTO = { uri: "file:///p.jpg", type: "image/jpeg", file: null } as const;

const recording = (answer: AuthedResult) => {
  const sent: Omit<ApiRequest, "accessToken">[] = [];
  return {
    sent,
    session: {
      request: async (request: Omit<ApiRequest, "accessToken">) => {
        sent.push(request);
        return answer;
      },
    },
  };
};

/** The app's side of photos (T-301b): what it may send, how it uploads, and what it says. */
describe("photos", () => {
  it("takes JPEG, PNG and WebP by their type, and refuses HEIC and anything unknown", () => {
    expect(photoTypeOf("image/jpeg")).toBe("image/jpeg");
    expect(photoTypeOf("image/JPG")).toBe("image/jpeg");
    expect(photoTypeOf("image/png")).toBe("image/png");
    expect(photoTypeOf("image/webp")).toBe("image/webp");
    expect(photoTypeOf("image/heic")).toBeUndefined();
    expect(photoTypeOf(null)).toBeUndefined();
    expect(photoTypeOf(undefined)).toBeUndefined();
  });

  it("reads what a quest accepts, text for an older API", () => {
    expect(acceptsOf({ submission: null })).toEqual({ text: true, photo: false });
    expect(acceptsOf({ submission: { accepts: ["photo"] } })).toEqual({ text: false, photo: true });
    expect(acceptsOf({ submission: { accepts: ["text", "photo"] } })).toEqual({
      text: true,
      photo: true,
    });
  });

  it("lets Send go with a photo and a short caption, or text where text is taken", () => {
    const photoOnly = { text: false, photo: true };
    const either = { text: true, photo: true };
    expect(canSendPhoto(photoOnly, null, "Words")).toBe(false);
    expect(canSendPhoto(photoOnly, PHOTO, "")).toBe(true);
    expect(canSendPhoto(photoOnly, PHOTO, "x".repeat(300))).toBe(true);
    expect(canSendPhoto(photoOnly, PHOTO, "x".repeat(301))).toBe(false);
    expect(canSendPhoto(either, null, "  ")).toBe(false);
    expect(canSendPhoto(either, null, "Words")).toBe(true);
    expect(canSendPhoto({ text: true, photo: false }, PHOTO, "")).toBe(false);
  });

  it("uploads the raw bytes with the photo's key and a long limit, and reads the id", async () => {
    const { sent, session } = recording({
      kind: "ok",
      status: 201,
      body: { photoId: "p1" },
      headers: new Headers(),
    });
    const data = new Blob(["jpeg"]);
    expect(
      await uploadPhoto(session, questPhotoPath("q 1"), { data, type: "image/png" }, "k1"),
    ).toEqual({ kind: "uploaded", photoId: "p1" });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/quests/q%201/photo",
        raw: { data, type: "image/png" },
        timeoutMs: 90_000,
        headers: { "idempotency-key": "k1" },
      },
    ]);
    expect(ticketPhotoPath("e1")).toBe("/v1/events/e1/tickets/photo");
  });

  it("says why an upload failed, and reads a malformed answer as the network", () => {
    const message = {
      ar: "أرسل صورة بصيغة JPEG أو PNG أو WebP.",
      en: "Send a JPEG, PNG or WebP photo.",
    };
    expect(
      uploadAnswer({
        kind: "error",
        status: 415,
        code: "photo_type",
        message,
        details: {},
        headers: new Headers(),
      }),
    ).toEqual({ kind: "refused", message });
    expect(uploadAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(uploadAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(uploadAnswer({ kind: "ok", status: 201, body: {}, headers: new Headers() })).toEqual({
      kind: "network",
    });
  });

  it("names what a refused pick means, and nothing for a pick or a cancel", () => {
    expect(pickLine({ kind: "denied" })).toBe("photo.cameraDenied");
    expect(pickLine({ kind: "unsupported" })).toBe("photo.unsupported");
    expect(pickLine({ kind: "unavailable" })).toBe("photo.updateApp");
    expect(pickLine({ kind: "cancelled" })).toBeNull();
    expect(pickLine({ kind: "picked", photo: PHOTO })).toBeNull();
  });

  it("sends a photo's id with its caption, and leaves an empty caption out", async () => {
    const answer: AuthedResult = {
      kind: "ok",
      status: 201,
      body: { status: "pending", points: 10 },
      headers: new Headers(),
    };
    const { sent, session } = recording(answer);
    await sendSubmission(session, "q1", "By the stage", "k", "p1");
    await sendSubmission(session, "q1", "  ", "k2", "p1");
    await sendSubmission(session, "q1", "Words", "k3");
    expect(sent.map((request) => request.body)).toEqual([
      { text: "By the stage", photoId: "p1" },
      { photoId: "p1" },
      { text: "Words" },
    ]);
  });
});
