import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchPhotoWall, saveOnScreen, wallPhotosOf } from "#src/event/photo-wall-api.ts";
import {
  mySubmissionsOf,
  photoChoiceFor,
  sendSubmission,
  type OwnSubmission,
} from "#src/event/submissions.ts";

const own = (fields: Partial<OwnSubmission>): OwnSubmission => ({
  id: "7",
  questId: "q1",
  status: "approved",
  points: 10,
  text: null,
  reason: null,
  reasonSystem: false,
  resubmit: false,
  kind: "photo",
  onScreen: false,
  ...fields,
});
const sessionAnswering = (answer: AuthedResult) => {
  const seen: unknown[] = [];
  return {
    seen,
    session: {
      request: async (request: unknown) => {
        seen.push(request);
        return answer;
      },
    },
  };
};
const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});

/** The photo wall in the app (T-504b): the wall's read, the player's choice at the send and afterwards. */
describe("the photo wall in the app", () => {
  it("keeps only photos with an id and an https URL", () => {
    expect(
      wallPhotosOf({
        photos: [
          { mediaId: "m1", url: "https://bucket.test/a", username: "sara" },
          { mediaId: "m2", url: "file:///etc/passwd" },
          { url: "https://bucket.test/b" },
        ],
      }),
    ).toEqual([{ mediaId: "m1", url: "https://bucket.test/a", username: "sara" }]);
    expect(wallPhotosOf({})).toBeUndefined();
  });

  it("reads the wall, and a 404 as off", async () => {
    const read = sessionAnswering(ok({ photos: [] }));
    expect(await fetchPhotoWall(read.session, "e1")).toEqual({ kind: "photos", photos: [] });
    const off = sessionAnswering({
      kind: "error",
      status: 404,
      code: "not_found",
      message: null,
      details: {},
      headers: new Headers(),
    });
    expect(await fetchPhotoWall(off.session, "e1")).toEqual({ kind: "off" });
    expect(await fetchPhotoWall(sessionAnswering(ok("x")).session, "e1")).toEqual({
      kind: "failed",
    });
  });

  it("saves the choice with a key on the submission's own path", async () => {
    const save = sessionAnswering(ok({ onScreen: false }));
    expect(await saveOnScreen(save.session, "e1", "7", false)).toBe(true);
    expect(save.seen[0]).toMatchObject({
      method: "PUT",
      path: "/v1/events/e1/submissions/7/on-screen",
      body: { onScreen: false },
    });
  });

  it("sends onScreen only for a photo the player allowed; an older API's answer reads as no wall", async () => {
    const sent = sessionAnswering(ok({}));
    await sendSubmission(sent.session, "q1", "", "k", "p1", true);
    await sendSubmission(sent.session, "q1", "", "k", "p1");
    await sendSubmission(sent.session, "q1", "Hi", "k", null, true);
    expect(sent.seen.map((one) => (one as { body: unknown }).body)).toEqual([
      { photoId: "p1", onScreen: true },
      { photoId: "p1" },
      { text: "Hi" },
    ]);
    expect(mySubmissionsOf({ submissions: [], pendingPoints: 0 })?.photoWall).toBe(false);
  });

  it("offers the choice afterwards for a live photo: withdraw always, allow while the wall runs", () => {
    const mine = (submission: OwnSubmission, photoWall: boolean) => ({
      submissions: [submission],
      pendingPoints: 0,
      photoWall,
    });
    expect(photoChoiceFor("q1", mine(own({ onScreen: true }), false))?.id).toBe("7");
    expect(photoChoiceFor("q1", mine(own({}), false))).toBeUndefined();
    expect(photoChoiceFor("q1", mine(own({}), true))?.id).toBe("7");
    expect(photoChoiceFor("q1", mine(own({ kind: "text" }), true))).toBeUndefined();
    expect(photoChoiceFor("q1", mine(own({ photoGone: true }), true))).toBeUndefined();
    expect(photoChoiceFor("q1", mine(own({ status: "rejected" }), true))).toBeUndefined();
    expect(photoChoiceFor("q2", mine(own({}), true))).toBeUndefined();
  });
});
