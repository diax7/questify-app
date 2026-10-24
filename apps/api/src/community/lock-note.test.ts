import { describe, expect, it } from "vitest";
import { lockNoteOf } from "#src/community/lock-note";

const note = {
  goalId: "goal-1",
  title: { ar: "أضيئوا البرج", en: "Light the tower" },
  measure: "points",
  threshold: "50",
  state: "waiting",
  startsAt: "2030-01-01T13:00:00+03:00",
};

describe("lockNoteOf", () => {
  it("is null when nothing is locked", () => {
    expect(lockNoteOf(null)).toBeNull();
    expect(lockNoteOf(undefined)).toBeNull();
    expect(lockNoteOf("locked")).toBeNull();
    expect(lockNoteOf(7)).toBeNull();
  });

  it("reads the note the database wrote, with the start in UTC and the threshold as a number", () => {
    expect(lockNoteOf(note)).toEqual({
      goalId: "goal-1",
      title: { ar: "أضيئوا البرج", en: "Light the tower" },
      measure: "points",
      threshold: 50,
      state: "waiting",
      startsAt: "2030-01-01T10:00:00.000Z",
    });
  });

  it("keeps each language of the title only when it is text", () => {
    expect(lockNoteOf({ ...note, title: { en: "Light the tower" } })?.title).toEqual({
      ar: null,
      en: "Light the tower",
    });
    expect(lockNoteOf({ ...note, title: { ar: "البرج", en: 5 } })?.title).toEqual({
      ar: "البرج",
      en: null,
    });
    expect(lockNoteOf({ ...note, title: null })?.title).toEqual({ ar: null, en: null });
  });
});
