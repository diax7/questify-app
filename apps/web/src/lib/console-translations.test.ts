import { MESSAGES, matrixRow, type MatrixRow } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  FIRST_VIEW,
  PAGE_SIZE,
  bodyOf,
  canSave,
  chipsOf,
  draftOf,
  insertPlaceholder,
  isChanged,
  notOnPhone,
  isDirty,
  isInvalid,
  keyPath,
  matrixPath,
  pagesOf,
  rangeOf,
  readMatrix,
  readSavedRow,
  revertBody,
  withRow,
} from "#src/lib/console-translations.ts";

const plain = (stored?: { ar: string | null; en: string | null }): MatrixRow =>
  matrixRow(
    MESSAGES,
    "nav.home",
    stored === undefined ? undefined : { key: "nav.home", ...stored },
  );
const counted = (stored?: { ar: string | null; en: string | null }): MatrixRow =>
  matrixRow(
    MESSAGES,
    "quests.pointsShort",
    stored === undefined ? undefined : { key: "quests.pointsShort", ...stored },
  );

describe("the matrix address", () => {
  it("asks for the first page of everything", () => {
    expect(matrixPath(FIRST_VIEW)).toBe(
      `/v1/admin/translations?show=all&offset=0&limit=${PAGE_SIZE}`,
    );
  });

  it("carries the search, the area, the filter and the page, and leaves out what is blank", () => {
    const path = matrixPath({ q: "  Redeem ", area: "rewards", show: "changed", page: 2 });
    expect(new URL(path, "https://x.test").searchParams.toString()).toBe(
      `q=Redeem&area=rewards&show=changed&offset=${2 * PAGE_SIZE}&limit=${PAGE_SIZE}`,
    );
    expect(matrixPath({ ...FIRST_VIEW, q: "   " })).not.toContain("q=");
  });

  it("escapes a key", () => {
    expect(keyPath("nav.home")).toBe("/v1/admin/translations/nav.home");
    expect(keyPath("a/b")).toBe("/v1/admin/translations/a%2Fb");
  });

  it("counts the pages and the range shown", () => {
    expect(pagesOf(0)).toBe(1);
    expect(pagesOf(PAGE_SIZE)).toBe(1);
    expect(pagesOf(PAGE_SIZE + 1)).toBe(2);
    expect(rangeOf(1, 7)).toEqual({ from: PAGE_SIZE + 1, to: PAGE_SIZE + 7 });
  });
});

describe("reading the API's answers", () => {
  it("accepts the matrix and a saved row, and refuses another shape", () => {
    const row = plain();
    expect(readMatrix({ total: 1, areas: [{ area: "nav", count: 8 }], rows: [row] })?.total).toBe(
      1,
    );
    expect(readMatrix({ total: "1" })).toBeUndefined();
    expect(readSavedRow({ row })?.key).toBe("nav.home");
    expect(readSavedRow({ row: { key: "nav.home" } })).toBeUndefined();
    expect(readSavedRow(undefined)).toBeUndefined();
  });
});

describe("editing a row", () => {
  it("starts from the text players see, the shipped one unless an admin changed it", () => {
    expect(draftOf(plain())).toEqual(MESSAGES["nav.home"]);
    expect(draftOf(plain({ ar: null, en: "Start" }))).toEqual({
      ar: MESSAGES["nav.home"].ar,
      en: "Start",
    });
  });

  it("is dirty only when a language differs from what players see, ignoring edges and digits", () => {
    const row = plain();
    const draft = draftOf(row);
    expect(isDirty(row, draft)).toBe(false);
    expect(isDirty(row, { ...draft, en: `  ${draft.en}  ` })).toBe(false);
    expect(isDirty(row, { ...draft, en: "Start" })).toBe(true);
  });

  it("sends only the changed language", () => {
    const row = plain();
    expect(bodyOf(row, { ...draftOf(row), en: "Start" })).toEqual({ en: "Start" });
  });

  it("sends a blank, or the shipped text, as a return to the shipped text", () => {
    const row = plain({ ar: null, en: "Start" });
    expect(bodyOf(row, { ...draftOf(row), en: "  " })).toEqual({ en: "" });
    expect(bodyOf(row, { ...draftOf(row), en: MESSAGES["nav.home"].en })).toEqual({ en: "" });
  });

  it("writes Arabic-Indic digits as 0-9", () => {
    const row = plain();
    expect(bodyOf(row, { ...draftOf(row), ar: "الصفحة ٣" })).toEqual({ ar: "الصفحة 3" });
  });

  it("lists the placeholders of the shipped text and which the draft lost or added", () => {
    const row = counted();
    expect(chipsOf(row, "en", "You have {points} {currency}")).toEqual({
      chips: [
        { name: "currency", state: "present" },
        { name: "points", state: "present" },
      ],
      extra: [],
    });
    expect(chipsOf(row, "en", "You have {points} and {coins}")).toEqual({
      chips: [
        { name: "currency", state: "missing" },
        { name: "points", state: "present" },
      ],
      extra: ["coins"],
    });
    expect(chipsOf(plain(), "en", "Start").chips).toEqual([]);
  });

  it("cannot be saved while a placeholder is missing or added, but a blank can", () => {
    const row = counted();
    const draft = draftOf(row);
    expect(canSave(row, { ...draft, en: "You have {points}" })).toBe(false);
    expect(isInvalid(row, { ...draft, en: "You have {points}" }, "en")).toBe(true);
    expect(canSave(row, { ...draft, en: "{points} {currency} {coins}" })).toBe(false);
    expect(canSave(row, { ...draft, en: "{points} of {currency}" })).toBe(true);
    expect(canSave(row, draft)).toBe(false);
    expect(canSave(plain({ ar: null, en: "Start" }), { ar: MESSAGES["nav.home"].ar, en: "" })).toBe(
      true,
    );
  });

  it("does not hold an untouched language against a save that fixes the other one", () => {
    const stale = counted({ ar: "لديك نقاط", en: null });
    const draft = draftOf(stale);
    expect(canSave(stale, { ...draft, en: "{points} {currency}!" })).toBe(true);
  });

  it("refuses a text over the length", () => {
    const row = plain();
    expect(canSave(row, { ...draftOf(row), en: "a".repeat(1001) })).toBe(false);
    expect(canSave(row, { ...draftOf(row), en: "a".repeat(1000) })).toBe(true);
  });
});

describe("a key the phone never shows", () => {
  it("is a console text, whatever else the key contains", () => {
    expect(notOnPhone("console.translations.title")).toBe(true);
    expect(notOnPhone("home.console.title")).toBe(false);
    expect(notOnPhone("consolex.title")).toBe(false);
  });
});

describe("reverting", () => {
  it("is offered only for a key with a change, and returns each changed language", () => {
    expect(isChanged(plain())).toBe(false);
    expect(isChanged(plain({ ar: null, en: "Start" }))).toBe(true);
    expect(revertBody(plain({ ar: null, en: "Start" }))).toEqual({ en: "" });
    expect(revertBody(plain({ ar: "البداية", en: "Start" }))).toEqual({ ar: "", en: "" });
  });

  it("is offered for a stored text the app ignores", () => {
    expect(isChanged(counted({ ar: null, en: "You have gems" }))).toBe(true);
  });
});

describe("placeholder chips", () => {
  it("puts the placeholder at the caret and moves the caret after it", () => {
    expect(insertPlaceholder("You have  gems", { start: 9, end: 9 }, "points")).toEqual({
      text: "You have {points} gems",
      caret: 17,
    });
  });

  it("replaces a selection, whichever way it was dragged", () => {
    expect(insertPlaceholder("abcdef", { start: 4, end: 1 }, "x")).toEqual({
      text: "a{x}ef",
      caret: 4,
    });
  });
});

describe("the list", () => {
  it("replaces one row by key", () => {
    const [a, b] = [plain(), counted()];
    const changed = plain({ ar: null, en: "Start" });
    expect(withRow([a, b], changed)).toEqual([changed, b]);
    expect(withRow([b], changed)).toEqual([b]);
  });
});
