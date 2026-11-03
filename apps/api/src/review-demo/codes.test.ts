import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import {
  createQuestCodeKey,
  createRevealCodeKey,
  createStepCodeKey,
  createTagCodeKey,
  verifyQuestCode,
  verifyRevealCode,
  verifyStepCode,
  verifyTagCode,
} from "#src/quests/qr";
import { listReviewCodes, reviewDemoFlag, type ReviewCodeDeps } from "#src/review-demo/codes";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const SECRET = "a-test-secret-that-is-long-enough-for-qr";
const ORIGIN = "https://questify.test";
const PLAYER = "00000000-0000-4000-8000-000000000001";
const EVENT = "00000000-0000-4000-8000-000000000002";
const ID = "00000000-0000-4000-8000-0000000000a1";
const QUEST = "00000000-0000-4000-8000-0000000000b1";

const keys = {
  codeKey: createQuestCodeKey(SECRET),
  stepKey: createStepCodeKey(SECRET),
  revealKey: createRevealCodeKey(SECRET),
  tagKey: createTagCodeKey(SECRET),
};

const depsOver = (answer: (sql: string) => FakeAnswer): ReviewCodeDeps => ({
  pool: fakePool(answer).pool,
  keys: createAuthKeys(SECRET),
  ...keys,
  origin: ORIGIN,
});

const row = (kind: string, fields: Record<string, unknown> = {}) => ({
  kind,
  id: ID,
  version: 3,
  quest_id: QUEST,
  title_ar: "البوابة",
  title_en: "Gate",
  label_ar: null,
  label_en: null,
  ...fields,
});

/** A client whose one query answers whether the caller is the reviewer. */
const ask = (here: boolean) => ({
  query: async () => ({ rows: [{ here }] }),
});

const tokenOf = (url: string | null, path: string) => {
  expect(url?.startsWith(`${ORIGIN}/${path}/`)).toBe(true);
  return url?.split("/").at(-1) ?? "";
};

describe("the review demo's code list (T-710b)", () => {
  it("signs each printable code with the key its sticker or tag uses", async () => {
    const deps = depsOver(() => ({
      rows: [
        row("quest"),
        row("step"),
        row("reveal", { quest_id: null }),
        row("tag", { label_ar: "بوابة", label_en: "Gate" }),
        row("meet"),
      ],
    }));
    const result = await listReviewCodes(deps, PLAYER, EVENT);
    expect(result.kind).toBe("done");
    const codes = result.kind === "done" ? result.value : [];
    expect(codes.map((code) => code.kind)).toEqual(["quest", "step", "reveal", "tag", "meet"]);
    const [quest, step, reveal, tag, meet] = codes;
    expect(verifyQuestCode(keys.codeKey, tokenOf(quest?.url ?? null, "q"), ID)).toEqual({
      kind: "valid",
      questId: ID,
      version: 3,
    });
    expect(verifyStepCode(keys.stepKey, tokenOf(step?.url ?? null, "q"), ID).kind).toBe("valid");
    expect(verifyRevealCode(keys.revealKey, tokenOf(reveal?.url ?? null, "q"), ID).kind).toBe(
      "valid",
    );
    expect(verifyTagCode(keys.tagKey, tokenOf(tag?.url ?? null, "t"))).toEqual({
      kind: "valid",
      tagId: ID,
      version: 3,
    });
    expect(meet?.url).toBeNull();
    expect(quest).toMatchObject({
      questId: QUEST,
      title: { ar: "البوابة", en: "Gate" },
      label: null,
    });
    expect(reveal?.questId).toBeNull();
    expect(tag?.label).toEqual({ ar: "بوابة", en: "Gate" });
  });

  it("answers not_found for the caller rule's refusal, and throws anything else", async () => {
    const refused = depsOver(() => {
      throw pgError({ code: "RD404" });
    });
    expect(await listReviewCodes(refused, PLAYER, EVENT)).toEqual({ kind: "not_found" });
    const broken = depsOver(() => {
      throw pgError({ code: "XX000" });
    });
    await expect(listReviewCodes(broken, PLAYER, EVENT)).rejects.toThrow(/XX000/);
  });

  it("gives Home the flag only when the database says the caller is the reviewer", async () => {
    expect(await reviewDemoFlag(ask(true) as never, EVENT)).toEqual({ reviewDemo: true });
    expect(await reviewDemoFlag(ask(false) as never, EVENT)).toEqual({});
  });
});
