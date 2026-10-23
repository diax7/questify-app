import { describe, expect, it } from "vitest";
import { handleOf, nameOf } from "#src/lib/players.ts";

describe("a player's name on the dashboard", () => {
  it("shows the username, with @ in lists", () => {
    expect(handleOf("sara_k", "en")).toBe("@sara_k");
    expect(nameOf("sara_k", "ar")).toBe("sara_k");
  });

  it("shows a deleted account as Deleted player, in both languages and without @", () => {
    expect(handleOf(null, "en")).toBe("Deleted player");
    expect(handleOf(null, "ar")).toBe("لاعب محذوف");
    expect(nameOf(null, "en")).toBe("Deleted player");
  });
});
