import { describe, expect, it } from "vitest";
import {
  CODE_MAX_LENGTH,
  createRewardCodeKey,
  markCode,
  normalizeCode,
  openCode,
  sealCode,
} from "#src/rewards/codes";

const KEY = createRewardCodeKey("r".repeat(32));
const OTHER_KEY = createRewardCodeKey("s".repeat(32));
const REWARD = "0b6f3c1e-8a52-4f0e-9d2a-5c7e1b3a9f10";
const OTHER_REWARD = "7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";

describe("reward code keys", () => {
  it("refuses a secret shorter than 32 characters", () => {
    expect(() => createRewardCodeKey("r".repeat(31))).toThrow(
      /REWARD_CODE_SECRET must be at least 32/,
    );
  });

  it("derives two different keys from one secret", () => {
    expect(KEY.seal.equals(KEY.mark)).toBe(false);
    expect(KEY.seal).toHaveLength(32);
  });
});

describe("sealing a code", () => {
  it("opens to the same code for the same reward", () => {
    const sealed = sealCode(KEY, REWARD, "SAVE-20-كود");
    expect(openCode(KEY, REWARD, sealed)).toBe("SAVE-20-كود");
  });

  it("never seals one code twice the same way", () => {
    expect(sealCode(KEY, REWARD, "A").equals(sealCode(KEY, REWARD, "A"))).toBe(false);
  });

  it("does not open for another reward, another key, or a changed byte", () => {
    const sealed = sealCode(KEY, REWARD, "GIFT-1");
    expect(openCode(KEY, OTHER_REWARD, sealed)).toBeUndefined();
    expect(openCode(OTHER_KEY, REWARD, sealed)).toBeUndefined();
    for (const at of [0, 12, 28, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[at] = (changed[at] ?? 0) ^ 0x01;
      expect(openCode(KEY, REWARD, changed), `byte ${at}`).toBeUndefined();
    }
    expect(openCode(KEY, REWARD, sealed.subarray(0, 28))).toBeUndefined();
    expect(openCode(KEY, REWARD, sealed.subarray(0, 3))).toBeUndefined();
    expect(openCode(KEY, REWARD, Buffer.alloc(0))).toBeUndefined();
  });

  it("fits the database's size check for the longest code", () => {
    const longest = sealCode(KEY, REWARD, "ك".repeat(CODE_MAX_LENGTH));
    expect(longest.length).toBeLessThanOrEqual(1024);
    expect(sealCode(KEY, REWARD, "A").length).toBeGreaterThanOrEqual(29);
  });
});

describe("normalizing and marking a code", () => {
  it("trims, applies NFC and refuses empty, long or control-character codes", () => {
    expect(normalizeCode("  AB-12 \n")).toBe("AB-12");
    expect(normalizeCode("é")).toBe("é");
    expect(normalizeCode("   ")).toBeUndefined();
    expect(normalizeCode("A".repeat(CODE_MAX_LENGTH))).toHaveLength(CODE_MAX_LENGTH);
    expect(normalizeCode("A".repeat(CODE_MAX_LENGTH + 1))).toBeUndefined();
    expect(normalizeCode("A\u0000B")).toBeUndefined();
    expect(normalizeCode("A\tB")).toBeUndefined();
  });

  it("marks a code the same way every time, and two codes differently", () => {
    expect(markCode(KEY, "A").equals(markCode(KEY, "A"))).toBe(true);
    expect(markCode(KEY, "A").equals(markCode(KEY, "B"))).toBe(false);
    expect(markCode(KEY, "A").equals(markCode(OTHER_KEY, "A"))).toBe(false);
    expect(markCode(KEY, "A")).toHaveLength(32);
  });
});
