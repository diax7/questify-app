import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { souvenirRefusal } from "#src/souvenirs/souvenirs";

const refusal = (error: unknown) => {
  try {
    souvenirRefusal(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("souvenirRefusal returned");
};

describe("souvenir SQL refusals", () => {
  it.each(["SV422", "23514", "23503", "22P02", "22P05"])("answers %s as 400", (code) => {
    const answer = refusal({ code, detail: "submitted name" });
    expect(answer).toBeInstanceOf(HttpError);
    expect((answer as HttpError).status).toBe(400);
    expect(JSON.stringify((answer as HttpError).envelope)).not.toContain("submitted name");
  });
  it("answers a known frozen state as 409 and passes an unknown error through", () => {
    expect((refusal({ code: "SV409", detail: "souvenir_locked" }) as HttpError).status).toBe(409);
    const unknown = { code: "XX000" };
    expect(refusal(unknown)).toBe(unknown);
  });
});
