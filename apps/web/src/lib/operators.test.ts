import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  ABILITIES,
  PRESETS,
  abilityKey,
  inviteBody,
  keySegment,
  presetKey,
  printable,
  withAbility,
  type InviteView,
} from "#src/lib/operators.ts";

const invite = (fields: Partial<InviteView>): InviteView => ({
  id: "i1",
  kind: "personal",
  label: "Gate",
  email: null,
  abilities: ["scan_quests"],
  status: "open",
  claimedBy: null,
  ...fields,
});

describe("operator copy keys", () => {
  it("names every ability and preset with a message in both languages", () => {
    expect(keySegment("show_rotating_qr")).toBe("showRotatingQr");
    for (const ability of ABILITIES) {
      expect(MESSAGES, ability).toHaveProperty([abilityKey(ability)]);
    }
    for (const preset of PRESETS) {
      expect(MESSAGES, preset).toHaveProperty([presetKey(preset)]);
    }
  });
});

describe("inviteBody", () => {
  const draft = { label: " Crew ", count: 5, email: " a@b.sa ", preset: "scanner" } as const;

  it("sends only what each kind uses", () => {
    expect(inviteBody({ ...draft, kind: "personal" }, "ar")).toEqual({
      kind: "personal",
      label: "Crew",
      preset: "scanner",
    });
    expect(inviteBody({ ...draft, kind: "batch" }, "ar")).toEqual({
      kind: "batch",
      label: "Crew",
      count: 5,
      preset: "scanner",
    });
    expect(inviteBody({ ...draft, kind: "email" }, "en")).toEqual({
      kind: "email",
      email: "a@b.sa",
      preset: "scanner",
      lang: "en",
    });
  });
});

describe("printable", () => {
  it("keeps the open invites that carry an address", () => {
    const open = invite({ id: "a", url: "https://x/en/op#t" });
    expect(
      printable([
        open,
        invite({ id: "b" }),
        invite({ id: "c", status: "claimed", url: "https://x/en/op#u" }),
      ]),
    ).toEqual([open]);
  });
});

describe("withAbility", () => {
  it("turns one ability on or off and keeps the API's order", () => {
    expect(withAbility(["review", "scan_quests"], "award", true)).toEqual([
      "scan_quests",
      "award",
      "review",
    ]);
    expect(withAbility(["scan_quests", "award"], "scan_quests", false)).toEqual(["award"]);
  });
});
