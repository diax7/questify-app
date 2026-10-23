import { describe, expect, it, vi } from "vitest";
import { revealAnswer, revealCategory } from "#src/event/reveal.ts";

const ok = (body: unknown) => ({ kind: "ok", status: 200, body, headers: new Headers() }) as const;
const error = (status: number, code: string, details: Record<string, unknown> = {}) =>
  ({
    kind: "error",
    status,
    code,
    message: { ar: "ليست مخفية", en: "Not hidden" },
    details,
    headers: new Headers(),
  }) as const;

describe("revealAnswer (T-304c)", () => {
  it("reads a found category, fresh or found before", () => {
    const name = { ar: "السر", en: null };
    expect(revealAnswer(ok({ categoryId: "c", name, revealed: true }))).toEqual({
      kind: "revealed",
      name,
      fresh: true,
    });
    expect(revealAnswer(ok({ categoryId: "c", name, revealed: false }))).toMatchObject({
      fresh: false,
    });
  });

  it("refuses a body that is not well formed", () => {
    expect(revealAnswer(ok({ name: "x", revealed: true }))).toEqual({ kind: "failed" });
    expect(revealAnswer(ok({ name: { ar: null, en: "x" } }))).toEqual({ kind: "failed" });
    expect(revealAnswer(ok(null))).toEqual({ kind: "failed" });
  });

  it("answers refusals as a scan's, a category not hidden in the API's words", () => {
    expect(revealAnswer(error(422, "not_hidden"))).toEqual({
      kind: "wrong_code",
      problem: { ar: "ليست مخفية", en: "Not hidden" },
    });
    expect(revealAnswer(error(422, "invalid_code"))).toMatchObject({ kind: "wrong_code" });
    expect(revealAnswer(error(403, "quest_not_open", { reason: "not_for_you" }))).toMatchObject({
      kind: "not_open",
      reason: "not_for_you",
    });
    expect(revealAnswer(error(404, "not_found"))).toEqual({ kind: "reload" });
    expect(revealAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(revealAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
  });
});

describe("revealCategory", () => {
  it("posts the code to the category's reveal route with no idempotency key", async () => {
    const request = vi.fn(async () =>
      ok({ categoryId: "c", name: { ar: null, en: "S" }, revealed: true }),
    );
    await revealCategory({ request }, "c/1", "TOKEN");
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/categories/c%2F1/reveal",
      body: { code: "TOKEN" },
    });
  });
});
