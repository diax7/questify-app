import { describe, expect, it } from "vitest";
import { admit, outcomeOf, settlesKey, type Admission } from "#src/operator/station-flow.ts";
import {
  REPEAT_MS,
  held,
  isPlayerCode,
  isRepeat,
  memoryIn,
  type ScanMemory,
} from "#src/operator/station.ts";

const CODE = "A".repeat(49) + "Q";
const OTHER = "B".repeat(49) + "Q";
const NOW = 1_000_000;

const memory = (fields: Partial<ScanMemory> = {}): ScanMemory => ({
  practice: false,
  last: null,
  attempt: null,
  ...fields,
});

// The station's `scanned` as it read a camera frame before the admission moved out of it, on plain values.
function oldAdmit(
  start: ScanMemory,
  practice: boolean,
  code: string,
  questId: string,
  now: number,
  busyBefore: boolean,
): Admission {
  let current = memoryIn(start, practice);
  const { last } = current;
  if (last !== null && isRepeat(last, code, questId, now)) {
    current = { ...current, last: held(last, now) };
    return { memory: current, action: "repeat" };
  }
  if (busyBefore) {
    return { memory: current, action: "busy" };
  }
  current = { ...current, last: { code, questId, at: now } };
  return { memory: current, action: isPlayerCode(code) ? "send" : "invalid" };
}

describe("admit", () => {
  const read = (
    fields: Partial<{ code: string; questId: string; now: number; busy: boolean }>,
  ) => ({
    code: CODE,
    questId: "q1",
    now: NOW,
    busy: false,
    ...fields,
  });

  it.each<[string, ScanMemory, boolean, Parameters<typeof read>[0], Admission["action"]]>([
    ["a first read of a player's code", memory(), false, {}, "send"],
    ["a read that cannot be a player's code", memory(), false, { code: "hello" }, "invalid"],
    ["a read while another is answered", memory(), false, { busy: true }, "busy"],
    [
      "the same code held up inside the window",
      memory({ last: { code: CODE, questId: "q1", at: NOW - 1000 } }),
      false,
      {},
      "repeat",
    ],
    [
      "the same code held up, even while another is answered",
      memory({ last: { code: CODE, questId: "q1", at: NOW - 1000 } }),
      false,
      { busy: true },
      "repeat",
    ],
    [
      "the same code once the window has passed",
      memory({ last: { code: CODE, questId: "q1", at: NOW - REPEAT_MS } }),
      false,
      {},
      "send",
    ],
    [
      "the same code at another station",
      memory({ last: { code: CODE, questId: "q2", at: NOW - 10 } }),
      false,
      {},
      "send",
    ],
    [
      "another code right after",
      memory({ last: { code: OTHER, questId: "q1", at: NOW - 10 } }),
      false,
      {},
      "send",
    ],
    [
      "the same code after practice mode changed",
      memory({ last: { code: CODE, questId: "q1", at: NOW - 10 } }),
      true,
      {},
      "send",
    ],
  ])("%s", (_name, start, practice, fields, action) => {
    const entry = admit(start, practice, read(fields));
    expect(entry.action).toBe(action);
    const { code, questId, now, busy } = read(fields);
    expect(entry).toEqual(oldAdmit(start, practice, code, questId, now, busy));
  });

  it("slides the window on a repeat and starts it on a new read", () => {
    const start = memory({ last: { code: CODE, questId: "q1", at: NOW - 4000 } });
    expect(admit(start, false, read({})).memory.last).toEqual({
      code: CODE,
      questId: "q1",
      at: NOW,
    });
    expect(admit(memory(), false, read({ code: OTHER })).memory.last).toEqual({
      code: OTHER,
      questId: "q1",
      at: NOW,
    });
  });

  it("forgets the last code when practice mode changes, and keeps the pending key", () => {
    const attempt = { code: CODE, questId: "q1", key: "k" };
    const start = memory({ attempt, last: { code: CODE, questId: "q1", at: NOW - 10 } });
    const entry = admit(start, true, read({ busy: true }));
    expect(entry.action).toBe("busy");
    expect(entry.memory).toEqual({ practice: true, last: null, attempt });
  });

  it("matches the old inline logic for every combination", () => {
    const lasts = [
      null,
      { code: CODE, questId: "q1", at: NOW - 100 },
      { code: CODE, questId: "q1", at: NOW - REPEAT_MS },
      { code: CODE, questId: "q2", at: NOW - 100 },
      { code: OTHER, questId: "q1", at: NOW - 100 },
    ];
    for (const last of lasts) {
      for (const was of [false, true]) {
        for (const practice of [false, true]) {
          for (const code of [CODE, OTHER, "", "nope", ` ${CODE} `]) {
            for (const busy of [false, true]) {
              const start = memory({
                practice: was,
                last,
                attempt: { code, questId: "q1", key: "k" },
              });
              expect(admit(start, practice, { code, questId: "q1", now: NOW, busy })).toEqual(
                oldAdmit(start, practice, code, "q1", NOW, busy),
              );
            }
          }
        }
      }
    }
  });
});

describe("outcomeOf and settlesKey", () => {
  // Old, for an answer that is not a result: `if removed ..; else if signed_out ..; else retry the same code`.
  it.each<[string, "removed" | "signed_out" | "retry", boolean]>([
    ["result", "retry", true],
    ["removed", "removed", true],
    ["signed_out", "signed_out", true],
    ["network", "retry", false],
    ["constructor", "retry", true],
    ["", "retry", true],
  ])("%s", (kind, outcome, settles) => {
    expect(outcomeOf(kind)).toBe(outcome);
    expect(settlesKey(kind)).toBe(settles);
  });
});
