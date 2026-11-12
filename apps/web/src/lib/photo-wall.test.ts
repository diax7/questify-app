import { describe, expect, it } from "vitest";
import { isEmpty, keptPhotos, sceneAnswerOf, wallPhotosOf } from "#src/lib/big-screen.ts";
import {
  addPick,
  morePhotos,
  movePick,
  pickerOf,
  removePick,
  WALL_MAX,
} from "#src/lib/photo-wall.ts";

const photo = (n: number) => ({
  submissionId: String(n),
  url: `https://media.example.test/p${n}.jpg?sig=a`,
  questTitle: { ar: null, en: "Team photo" },
});

/** The photo wall on the web (T-504b): the screen's scene and the team's picker. */
describe("the photo wall scene", () => {
  it("reads only photos with an id and an https URL, and is empty without any", () => {
    const answer = sceneAnswerOf("photo", {
      shut: null,
      photos: [
        { mediaId: "a", url: "https://media.example.test/a.jpg", key: "o/x" },
        { mediaId: "b", url: "javascript:alert(1)" },
        { url: "https://media.example.test/c.jpg" },
      ],
    });
    expect(answer).toEqual({
      scene: "photo",
      shut: null,
      photos: [{ mediaId: "a", url: "https://media.example.test/a.jpg" }],
    });
    expect(isEmpty(answer as NonNullable<typeof answer>)).toBe(false);
    expect(isEmpty({ scene: "photo", shut: null, photos: [] })).toBe(true);
    expect(wallPhotosOf("nope")).toEqual([]);
    expect(
      wallPhotosOf(
        Array.from({ length: 25 }, (_, i) => ({ mediaId: String(i), url: "https://x" })),
      ),
    ).toHaveLength(20);
  });

  it("keeps a shown photo's first URL, takes a new photo's URL and drops one that left (M2)", () => {
    const shown = [
      { mediaId: "a", url: "https://m/a?1" },
      { mediaId: "b", url: "https://m/b?1" },
    ];
    const latest = [
      { mediaId: "b", url: "https://m/b?2" },
      { mediaId: "c", url: "https://m/c?2" },
    ];
    expect(keptPhotos(shown, latest)).toEqual([
      { mediaId: "b", url: "https://m/b?1" },
      { mediaId: "c", url: "https://m/c?2" },
    ]);
  });
});

describe("the team's picker", () => {
  it("reads the picker's answer, leaving out entries without an https URL", () => {
    expect(
      pickerOf({
        picked: [photo(1), { submissionId: "2", url: "http://x" }],
        candidates: [photo(3)],
        cursor: "3",
      }),
    ).toEqual({ picked: [photo(1)], candidates: [photo(3)], cursor: "3" });
    expect(pickerOf({ picked: [] })).toBeUndefined();
  });

  it("adds once, up to 20, removes, moves, and pages without repeats", () => {
    const one = addPick([], photo(1));
    expect(addPick(one, photo(1))).toBe(one);
    const full = Array.from({ length: WALL_MAX }, (_, i) => photo(i + 10));
    expect(addPick(full, photo(1))).toBe(full);
    const two = addPick(one, photo(2));
    expect(movePick(two, 1, -1).map((p) => p.submissionId)).toEqual(["2", "1"]);
    expect(movePick(two, 0, -1)).toBe(two);
    expect(removePick(two, "1").map((p) => p.submissionId)).toEqual(["2"]);
    expect(morePhotos([photo(1)], [photo(1), photo(2)]).map((p) => p.submissionId)).toEqual([
      "1",
      "2",
    ]);
  });
});
