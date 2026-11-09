import { frameDesign, type Equipment } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { avatarFace } from "#src/components/avatar-face.ts";
import { avatarLook } from "#src/components/avatar-look.ts";

// The inline logic of Avatar as it was before the split, copied unchanged (the theme colour is the null case).
function oldLook(name: string, username: string, size: number, equipment?: Equipment) {
  const chosen = equipment?.character?.visualKey ?? name;
  const face = avatarFace(chosen, username);
  const frame = frameDesign(equipment?.frame?.visualKey);
  const radius = frame?.rounded === false ? size * 0.25 : size / 2;
  const border = frame === null ? 1 : Math.max(1, size * 0.06);
  return {
    chosen,
    face,
    radius,
    border,
    borderColor: frame === null ? null : "#8B5A2B",
    ring:
      frame === null
        ? null
        : {
            position: "absolute",
            inset: 0,
            borderRadius: Math.max(0, radius - border),
            borderWidth: border,
            borderColor: frame.color,
            borderStyle: frame.double ? "dashed" : "solid",
          },
    motif:
      frame?.motif === true
        ? {
            position: "absolute",
            top: 0,
            width: Math.max(2, size * 0.08),
            height: Math.max(2, size * 0.08),
            backgroundColor: "#8B5A2B",
            transform: [{ rotate: "45deg" }],
          }
        : null,
  };
}

const item = (visualKey: string | null) => ({ visualKey }) as never;

const FRAME_KEYS: readonly (string | null | undefined)[] = [
  undefined,
  null,
  "",
  "bogus",
  "frame-00",
  ...Array.from({ length: 22 }, (_, index) => `frame-${String(index).padStart(2, "0")}`),
  "toString",
];
const CHARACTER_KEYS: readonly (string | null | undefined)[] = [
  undefined,
  null,
  "chest",
  "fox",
  "owl",
  "bogus",
  "toString",
];
const NAMES = ["fox", "chest", "explorer-hat", "bogus", "constructor", ""];
const USERNAMES = ["", "sara", "عمر"];
const SIZES = [0, 12, 24, 32, 40, 64, 100, 128];

const worn = (visualKey: string) =>
  avatarLook("fox", "sara", 40, { frame: item(visualKey) } as unknown as Equipment);

describe("avatarLook", () => {
  it("matches the inline logic for every frame, character, name, username and size", () => {
    let count = 0;
    const equipments: (Equipment | undefined)[] = [undefined];
    for (const character of CHARACTER_KEYS) {
      for (const frame of FRAME_KEYS) {
        equipments.push({
          character: character === undefined ? null : item(character),
          frame: frame === undefined ? null : item(frame),
          title: null,
        } as unknown as Equipment);
        equipments.push({
          ...(character === undefined ? {} : { character: item(character) }),
          ...(frame === undefined ? {} : { frame: item(frame) }),
        } as unknown as Equipment);
      }
    }
    for (const equipment of equipments) {
      for (const name of NAMES) {
        for (const username of USERNAMES) {
          for (const size of SIZES) {
            expect(avatarLook(name, username, size, equipment)).toEqual(
              oldLook(name, username, size, equipment),
            );
            count += 1;
          }
        }
      }
    }
    expect(count).toBe((1 + 2 * CHARACTER_KEYS.length * FRAME_KEYS.length) * 6 * 3 * 8);
  });

  it("wears a ring only for a known frame, and a diamond only when it has a motif", () => {
    expect(worn("bogus").ring).toBeNull();
    expect(worn("frame-01").ring).not.toBeNull();
    expect(worn("frame-01").motif).not.toBeNull();
    expect(worn("frame-02").motif).toBeNull();
  });
});
