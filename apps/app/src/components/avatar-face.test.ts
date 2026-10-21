import { AVATARS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { avatarFace } from "#src/components/avatar-face.ts";

describe("avatarFace", () => {
  it("shows the image of each of the six avatars", () => {
    for (const avatar of AVATARS) {
      expect(avatarFace(avatar, "sara")).toEqual({ kind: "image", avatar });
    }
  });

  it("shows the username's first letter for an avatar this app does not know", () => {
    expect(avatarFace("dragon", "sara")).toEqual({ kind: "letter", letter: "S" });
    expect(avatarFace("toString", "khalid")).toEqual({ kind: "letter", letter: "K" });
    expect(avatarFace("", "")).toEqual({ kind: "letter", letter: "" });
  });
});
