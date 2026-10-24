import { describe, expect, it } from "vitest";
import {
  KIOSK_DROP_MS,
  KIOSK_IN_PROGRESS_WAIT_MS,
  createDecoder,
  createKioskReader,
  frameSize,
  kioskCardOf,
  kioskShutKey,
  looksLikeQuestifyCode,
  outcomeOf,
  reasonKey,
  storeFacing,
  storedFacing,
  type KioskOutcome,
} from "#src/lib/kiosk.ts";
import type { PostResult } from "#src/lib/post-json.ts";

const CODE = "A".repeat(50);
const OTHER = "B".repeat(50);
const PAID: PostResult = {
  ok: true,
  body: { result: "completed", player: { username: "sara", avatar: "fox" }, points: 10 },
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A reader over a fake clock and a fake API whose answers the test hands out one by one. */
function harness() {
  let now = 0;
  let keys = 0;
  const sent: Array<Readonly<{ code: string; key: string }>> = [];
  const outcomes: KioskOutcome[] = [];
  const answers: Array<(result: PostResult) => void> = [];
  const waited: number[] = [];
  const reader = createKioskReader({
    send: (code, key) => {
      sent.push({ code, key });
      return new Promise((resolve) => answers.push(resolve));
    },
    newKey: () => `key-${(keys += 1)}`,
    now: () => now,
    wait: async (ms: number) => {
      waited.push(ms);
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const answer = async (result: PostResult) => {
    answers.shift()?.(result);
    await flush();
  };
  return {
    reader,
    sent,
    outcomes,
    waited,
    answer,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the Questify-shape filter (T-309b)", () => {
  it("sends only 43 to 60 base64url characters, never a URL or a product barcode", () => {
    expect(looksLikeQuestifyCode("A".repeat(43))).toBe(true);
    expect(looksLikeQuestifyCode("a-_9".repeat(15))).toBe(true);
    expect(looksLikeQuestifyCode("A".repeat(42))).toBe(false);
    expect(looksLikeQuestifyCode("A".repeat(61))).toBe(false);
    expect(looksLikeQuestifyCode(`https://questify.nafes.com/s/${CODE}`)).toBe(false);
    expect(looksLikeQuestifyCode("6281234567890")).toBe(false);
    expect(looksLikeQuestifyCode(`${"A".repeat(49)}=`)).toBe(false);
  });
});

describe("the kiosk reader", () => {
  it("shows a junk read locally, sends nothing, and shows it once per 5 seconds", () => {
    const run = harness();
    run.reader.read("not a code");
    run.reader.read("not a code");
    expect(run.sent).toEqual([]);
    expect(run.outcomes).toEqual([
      { kind: "card", card: { kind: "refused", reason: "invalid_code" } },
    ]);
  });

  it("drops a code just sent for 5 seconds: one held-up phone is one scan", async () => {
    const run = harness();
    run.reader.read(CODE);
    await run.answer(PAID);
    run.reader.read(CODE);
    run.advance(KIOSK_DROP_MS - 1);
    run.reader.read(CODE);
    expect(run.sent).toHaveLength(1);
    run.advance(1);
    run.reader.read(CODE);
    expect(run.sent).toHaveLength(2);
  });

  it("keeps one scan in flight; the newest code read meanwhile goes next", async () => {
    const run = harness();
    run.reader.read(CODE);
    run.reader.read(OTHER);
    run.reader.read(CODE);
    run.reader.read(OTHER);
    expect(run.sent.map((one) => one.code)).toEqual([CODE]);
    await run.answer(PAID);
    expect(run.sent.map((one) => one.code)).toEqual([CODE, OTHER]);
    await run.answer(PAID);
    expect(run.sent).toHaveLength(2);
  });

  it("retries a network failure once with the same key, then says reconnecting; never queued", async () => {
    const run = harness();
    run.reader.read(CODE);
    await run.answer({ ok: false, body: undefined });
    await run.answer({ ok: false, body: undefined });
    expect(run.sent).toEqual([
      { code: CODE, key: "key-1" },
      { code: CODE, key: "key-1" },
    ]);
    expect(run.outcomes).toEqual([{ kind: "reconnecting" }]);
    run.advance(KIOSK_DROP_MS);
    run.reader.read(OTHER);
    expect(run.sent.at(-1)).toEqual({ code: OTHER, key: "key-2" });
  });

  it("asks once more with the same key while the API is still answering it, then shows a neutral card", async () => {
    const busy: PostResult = { ok: false, body: { code: "request_in_progress" } };
    const run = harness();
    run.reader.read(CODE);
    await run.answer({ ok: false, body: undefined });
    await run.answer(busy);
    await run.answer(PAID);
    expect(run.sent.map((one) => one.key)).toEqual(["key-1", "key-1", "key-1"]);
    expect(run.waited).toEqual([KIOSK_IN_PROGRESS_WAIT_MS]);
    expect(run.outcomes).toEqual([outcomeOf(PAID)]);

    const still = harness();
    still.reader.read(CODE);
    await still.answer(busy);
    await still.answer(busy);
    expect(still.sent).toHaveLength(2);
    expect(still.outcomes).toEqual([{ kind: "card", card: { kind: "received" } }]);
  });

  it("does not retry an answer the API gave", async () => {
    const run = harness();
    run.reader.read(CODE);
    await run.answer({ ok: false, body: { code: "busy" } });
    expect(run.sent).toHaveLength(1);
    expect(run.outcomes).toEqual([{ kind: "reconnecting" }]);
  });
});

describe("the kiosk's answers", () => {
  it("reads green with the player, orange, and red with the reason only", () => {
    expect(kioskCardOf({ ...(PAID.body as object), boosted: true })).toEqual({
      kind: "paid",
      player: { username: "sara", avatar: "fox" },
      points: 10,
      boosted: true,
    });
    expect(kioskCardOf({ result: "already_completed", player: { username: "sara" } })).toEqual({
      kind: "already",
      player: { username: "sara", avatar: "" },
    });
    expect(
      kioskCardOf({ result: "refused", reason: "not_open", player: { username: "sara" } }),
    ).toEqual({ kind: "refused", reason: "not_open" });
    expect(kioskCardOf({ result: "completed" })).toBeUndefined();
    expect(kioskCardOf({ result: "refused" })).toBeUndefined();
    expect(kioskCardOf("nope")).toBeUndefined();
  });

  it("turns errors into the page's states", () => {
    expect(outcomeOf({ ok: false, body: { code: "device_unpaired" } })).toEqual({
      kind: "unpaired",
    });
    expect(
      outcomeOf({
        ok: false,
        body: { code: "too_many_attempts", details: { retryAfterSeconds: 42 } },
      }),
    ).toEqual({ kind: "slowed", forMs: 42_000 });
    expect(outcomeOf({ ok: false, body: { code: "too_many_attempts" } })).toEqual({
      kind: "slowed",
      forMs: 5000,
    });
    expect(outcomeOf({ ok: false, body: { code: "feature_off" } })).toEqual({ kind: "off" });
    expect(outcomeOf({ ok: true, body: { result: "odd" } })).toEqual({ kind: "reconnecting" });
    expect(outcomeOf(PAID)).toMatchObject({ kind: "card", card: { kind: "paid" } });
  });

  it("names every red reason, and an unknown one as not open", () => {
    expect(reasonKey("needs_live_code")).toBe("kiosk.needsLive");
    expect(reasonKey("self_scan")).toBe("kiosk.selfScan");
    expect(reasonKey("expired")).toBe("kiosk.expired");
    expect(reasonKey("banned")).toBe("kiosk.notOpen");
    expect(kioskShutKey("paused")).toBe("kiosk.paused");
    expect(kioskShutKey("method_off")).toBe("kiosk.methodOff");
    expect(kioskShutKey("feature_off")).toBe("device.notAvailable");
    expect(kioskShutKey("hidden")).toBeUndefined();
  });
});

describe("frames and the camera", () => {
  it("scales a frame to at most 640 pixels on its longest side", () => {
    expect(frameSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(frameSize(720, 1280)).toEqual({ width: 360, height: 640 });
    expect(frameSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(frameSize(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it("remembers the camera, and falls back to the front one when storage is missing or refuses", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(storedFacing(storage)).toBe("user");
    storeFacing(storage, "environment");
    expect(storedFacing(storage)).toBe("environment");
    expect(storedFacing(undefined)).toBe("user");
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(storedFacing(refusing)).toBe("user");
    expect(() => storeFacing(refusing, "user")).not.toThrow();
  });
});

describe("the frame decoder", () => {
  it("reports a reader that cannot load once, and skips every frame after", async () => {
    const failures: unknown[] = [];
    const decoder = createDecoder<string>(
      () => Promise.reject(new Error("wasm 404")),
      (error) => failures.push(error),
    );
    expect(await decoder.read("frame")).toBeUndefined();
    expect(await decoder.read("frame")).toBeUndefined();
    expect(decoder.failed()).toBe(true);
    expect(failures).toHaveLength(1);
  });

  it("reads the first valid code; a frame it cannot read is no code", async () => {
    let calls = 0;
    const decoder = createDecoder<string>(
      async () => async (image) => {
        calls += 1;
        if (image === "bad") {
          throw new Error("unreadable");
        }
        return [
          { text: "x", isValid: false },
          { text: image, isValid: true },
        ];
      },
      () => undefined,
    );
    expect(await decoder.read(CODE)).toBe(CODE);
    expect(await decoder.read("bad")).toBeUndefined();
    expect(await decoder.read("")).toBeUndefined();
    expect(decoder.failed()).toBe(false);
    expect(calls).toBe(3);
  });
});
