import { describe, expect, it } from "vitest";
import { SHOP_STATES, shopWindowSchema } from "#src/rewards/shop-window";

const window = {
  state: "open",
  closesAt: "2030-01-04T18:00:00.000Z",
  deskEndsAt: "2030-01-02T18:00:00.000Z",
};
const accepts = (value: unknown) => shopWindowSchema.safeParse(value).success;

describe("shopWindowSchema", () => {
  it("keeps the state, the close and the desk's end", () => {
    expect(shopWindowSchema.parse(window)).toEqual(window);
    const bare = { state: "not_open", closesAt: null, deskEndsAt: null };
    expect(shopWindowSchema.parse(bare)).toEqual(bare);
  });

  it("names the three states and refuses any other", () => {
    expect(SHOP_STATES).toEqual(["not_open", "open", "closed"]);
    for (const state of SHOP_STATES) expect(accepts({ ...window, state })).toBe(true);
    for (const state of ["", "Open", "archived", null, undefined])
      expect(accepts({ ...window, state })).toBe(false);
  });

  it("takes each time as an instant with its offset, or null, never left out", () => {
    for (const field of ["closesAt", "deskEndsAt"]) {
      expect(accepts({ ...window, [field]: "2030-01-04T21:00:00+03:00" })).toBe(true);
      for (const value of ["2030-01-04", "2030-01-04T18:00", "soon", 5, undefined])
        expect(accepts({ ...window, [field]: value }), `${field} ${String(value)}`).toBe(false);
    }
  });
});
