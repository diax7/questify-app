import { describe, expect, it } from "vitest";
import { tabBarLabelStyle, tabBarStyle } from "#src/platform/tab-bar-style.ts";

const LABEL = { fontFamily: "Rubik_600SemiBold", fontSize: 13, lineHeight: 18 };

describe("tabBarStyle", () => {
  it("keeps the phones' bar as it was: the colour and a left-to-right order", () => {
    expect(tabBarStyle("#895a2b", "ios")).toEqual({ backgroundColor: "#895a2b", direction: "ltr" });
    expect(tabBarStyle("#895a2b", "android")).toEqual({
      backgroundColor: "#895a2b",
      direction: "ltr",
    });
  });

  it("gives the browser's bar room for the labels and the phone's bottom inset, in the same order", () => {
    expect(tabBarStyle("#895a2b", "web")).toEqual({
      backgroundColor: "#895a2b",
      direction: "ltr",
      height: "calc(72px + env(safe-area-inset-bottom, 0px))",
      paddingTop: 6,
      paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
    });
  });
});

describe("tabBarLabelStyle", () => {
  it("is the font alone on a phone", () => {
    expect(tabBarLabelStyle(LABEL, "ios")).toEqual({
      fontFamily: "Rubik_600SemiBold",
      fontSize: 13,
    });
  });

  it("gives the browser's label a line height, a taller box and no shrinking, so no letter is cut", () => {
    expect(tabBarLabelStyle(LABEL, "web")).toEqual({
      fontFamily: "Rubik_600SemiBold",
      fontSize: 13,
      lineHeight: 18,
      height: 22,
      flexShrink: 0,
    });
  });
});
