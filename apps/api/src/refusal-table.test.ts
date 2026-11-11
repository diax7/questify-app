import { describe, expect, it, vi } from "vitest";
import { HttpError } from "#src/http-error";
import { refusalThrower } from "#src/refusal-table";

type Own = Readonly<{ kind: "gone" }> | Readonly<{ kind: "late"; seconds: number }>;
type Other = Readonly<{ kind: "elsewhere" }>;

const text = { ar: "لا", en: "No" };
const table = {
  gone: () => new HttpError(404, "gone", text),
  late: (result: Readonly<{ kind: "late"; seconds: number }>, tag: string) =>
    new HttpError(429, "late", text, { seconds: result.seconds, tag }),
};

describe("refusalThrower", () => {
  it("throws the table's answer for a kind it holds, with the rest arguments", () => {
    const otherwise = vi.fn<(result: Other, tag: string) => never>();
    const refuse = refusalThrower<Own, [string], Other>(table, otherwise);
    expect(() => refuse({ kind: "late", seconds: 7 }, "t")).toThrow(
      expect.objectContaining({
        status: 429,
        envelope: expect.objectContaining({ details: { seconds: 7, tag: "t" } }),
      }),
    );
    expect(otherwise).not.toHaveBeenCalled();
  });

  it("hands a kind the table does not hold to otherwise, with the rest arguments", () => {
    const otherwise = vi.fn<(result: Other, tag: string) => never>(() => {
      throw new HttpError(409, "elsewhere", text);
    });
    const refuse = refusalThrower<Own, [string], Other>(table, otherwise);
    expect(() => refuse({ kind: "elsewhere" }, "t")).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(otherwise).toHaveBeenCalledWith({ kind: "elsewhere" }, "t");
  });

  it("returns nothing for an unknown or inherited kind when there is no otherwise", () => {
    const refuse = refusalThrower<Own, [string]>(table);
    for (const kind of ["elsewhere", "constructor", "__proto__"]) {
      expect(refuse({ kind } as never, "t")).toBeUndefined();
    }
  });
});
