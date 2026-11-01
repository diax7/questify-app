import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  NAME_AUDIENCES,
  NAME_DISPLAYS,
  isNameAudience,
  isNameDisplay,
  nameNoticeKey,
  nameNoticeOf,
  nameText,
  playerNameDisplay,
  shownName,
} from "#src/join/names";

describe("who is told about a full name", () => {
  it("tells nobody when the event shows usernames only, whoever the audience", () => {
    expect(nameNoticeOf("username", "staff")).toBeNull();
    expect(nameNoticeOf("username", "everyone")).toBeNull();
    expect(nameNoticeKey("username", "everyone")).toBeNull();
  });

  it("tells the audience for a full name or both", () => {
    expect(nameNoticeOf("full_name", "staff")).toBe("staff");
    expect(nameNoticeOf("both", "everyone")).toBe("everyone");
  });

  it("has a card sentence in both languages for every notice that can be shown", () => {
    for (const display of ["full_name", "both"] as const) {
      for (const audience of NAME_AUDIENCES) {
        const key = nameNoticeKey(display, audience);
        expect(key, `${display}/${audience}`).not.toBeNull();
        expect(MESSAGES[key as "joinCard.nameStaff"].ar.length).toBeGreaterThan(0);
        expect(MESSAGES[key as "joinCard.nameStaff"].en.length).toBeGreaterThan(0);
      }
    }
  });

  it("says in the staff sentence that other players see the username", () => {
    expect(nameNoticeKey("both", "staff")).toBe("joinCard.nameStaff");
    expect(MESSAGES["joinCard.nameStaff"].en).toContain("Other players see your username");
  });
});

describe("what other players see", () => {
  it("shows the display only when everyone may see it", () => {
    expect(playerNameDisplay("both", "everyone")).toBe("both");
    expect(playerNameDisplay("full_name", "everyone")).toBe("full_name");
    expect(playerNameDisplay("both", "staff")).toBe("username");
    expect(playerNameDisplay("full_name", "staff")).toBe("username");
    expect(playerNameDisplay("username", "everyone")).toBe("username");
  });
});

describe("how a row names a player", () => {
  it("draws the username alone for the username display, even when a full name is given", () => {
    expect(shownName("Sara Ahmed", "username")).toEqual({ fullName: null, showUsername: true });
  });

  it("draws the full name alone, or with the username for both", () => {
    expect(shownName("Sara Ahmed", "full_name")).toEqual({
      fullName: "Sara Ahmed",
      showUsername: false,
    });
    expect(shownName("Sara Ahmed", "both")).toEqual({ fullName: "Sara Ahmed", showUsername: true });
  });

  it("falls back to the username for a player without a full name", () => {
    for (const display of NAME_DISPLAYS) {
      expect(shownName(null, display)).toEqual({ fullName: null, showUsername: true });
      expect(shownName("   ", display)).toEqual({ fullName: null, showUsername: true });
    }
  });

  it("reads a name as plain text", () => {
    expect(nameText("sara_q", "Sara Ahmed", "both")).toBe("Sara Ahmed (@sara_q)");
    expect(nameText("sara_q", "Sara Ahmed", "full_name")).toBe("Sara Ahmed");
    expect(nameText("sara_q", "Sara Ahmed", "username")).toBe("@sara_q");
    expect(nameText("sara_q", null, "full_name")).toBe("@sara_q");
  });

  it("recognises only the known displays and audiences", () => {
    expect(isNameDisplay("both")).toBe(true);
    expect(isNameDisplay("nickname")).toBe(false);
    expect(isNameDisplay(undefined)).toBe(false);
    expect(isNameAudience("staff")).toBe(true);
    expect(isNameAudience("public")).toBe(false);
  });
});
