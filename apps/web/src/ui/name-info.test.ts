import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { nameInfo } from "#src/ui/name-info.ts";

const tip = createElement("button", { title: "More information" });

describe("nameInfo", () => {
  it("tells an info button the label it sits beside", () => {
    expect(nameInfo(tip, "Boosts")).toMatchObject({ props: { subject: "Boosts" } });
  });

  it("leaves the button alone when the label is not plain text", () => {
    expect(nameInfo(tip, createElement("em", null, "Boosts"))).toBe(tip);
    expect(nameInfo(tip, undefined)).toBe(tip);
  });

  it("passes on what is not a button", () => {
    expect(nameInfo(undefined, "Boosts")).toBeUndefined();
    expect(nameInfo("text", "Boosts")).toBe("text");
  });
});
