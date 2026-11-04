import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import {
  createQuestCodeKey,
  createRevealCodeKey,
  createStepCodeKey,
  verifyQuestCode,
  verifyRevealCode,
  verifyStepCode,
} from "#src/quests/qr";
import {
  listReviewCodes,
  reviewDemoFlag,
  reviewMeetCode,
  type ReviewCodeDeps,
} from "#src/review-demo/codes";
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
const ask = (here?: boolean) => ({
  query: async () => ({ rows: here === undefined ? [] : [{ here }] }),
});

const tokenOf = (url: string | null, path: string) => {
  expect(url?.startsWith(`${ORIGIN}/${path}/`)).toBe(true);
  return url?.split("/").at(-1) ?? "";
};

describe("the review demo's code list (T-710b)", () => {
  it("signs each printable code with the key its sticker uses", async () => {
    const deps = depsOver(() => ({
      rows: [
        row("quest"),
        row("step", { label_ar: "بوابة", label_en: "Gate" }),
        row("reveal", { quest_id: null }),
        row("meet"),
      ],
    }));
    const result = await listReviewCodes(deps, PLAYER, EVENT);
    expect(result.kind).toBe("done");
    const codes = result.kind === "done" ? result.value : [];
    expect(codes.map((code) => code.kind)).toEqual(["quest", "step", "reveal", "meet"]);
    const [quest, step, reveal, meet] = codes;
    expect(verifyQuestCode(keys.codeKey, tokenOf(quest?.url ?? null, "q"), ID)).toEqual({
      kind: "valid",
      questId: ID,
      version: 3,
    });
    expect(verifyStepCode(keys.stepKey, tokenOf(step?.url ?? null, "q"), ID).kind).toBe("valid");
    expect(verifyRevealCode(keys.revealKey, tokenOf(reveal?.url ?? null, "q"), ID).kind).toBe(
      "valid",
    );
    expect(meet?.url).toBeNull();
    expect(quest).toMatchObject({
      questId: QUEST,
      title: { ar: "البوابة", en: "Gate" },
      label: null,
    });
    expect(reveal?.questId).toBeNull();
    expect(step?.label).toEqual({ ar: "بوابة", en: "Gate" });
  });

  it("keeps a label that has only one of its two languages", async () => {
    const deps = depsOver(() => ({
      rows: [row("step", { label_en: "Gate" }), row("step", { label_ar: "بوابة" })],
    }));
    const result = await listReviewCodes(deps, PLAYER, EVENT);
    const codes = result.kind === "done" ? result.value : [];
    expect(codes.map((code) => code.label)).toEqual([
      { ar: null, en: "Gate" },
      { ar: "بوابة", en: null },
    ]);
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
    expect(await reviewDemoFlag(ask() as never, EVENT)).toEqual({});
  });
});

const QUEST_ID = "00000000-0000-4000-8000-0000000000c1";
/** Deps whose meet-pass window already holds `count` passes; the code door answers one pass. */
const meetDeps = (count: number) => {
  const fake = fakePool((sql) => {
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
    if (sql.includes("count(*)")) return { rows: [{ count, retry_after: 42 }] };
    if (sql.includes("INSERT INTO auth_throttle")) return { rows: [{ at: "now" }] };
    return { rows: [{ expires_at: new Date("2026-11-04T10:00:00Z") }] };
  });
  const deps: ReviewCodeDeps = { ...depsOver(() => ({})), pool: fake.pool };
  return { deps, queries: fake.queries };
};
const request = { playerId: PLAYER, eventId: EVENT, questId: QUEST_ID };

describe("the review demo's meet code (T-710b)", () => {
  it("counts the pass against the caller's meet-pass limit before issuing it", async () => {
    const { deps, queries } = meetDeps(0);
    const result = await reviewMeetCode(deps, request);
    expect(result).toMatchObject({
      kind: "done",
      value: { expiresAt: "2026-11-04T10:00:00.000Z" },
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO auth_throttle"))).toBe(true);
  });

  it("holds back a caller over the limit without asking the database for a code", async () => {
    const { deps, queries } = meetDeps(30);
    expect(await reviewMeetCode(deps, request)).toEqual({
      kind: "too_many_attempts",
      retryAfterSeconds: 42,
    });
    expect(queries.some((sql) => sql.includes("review_demo_meet_code"))).toBe(false);
  });
});
