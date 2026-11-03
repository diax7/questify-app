import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countLogEvent, logTelemetry } from "#src/telemetry/logs";
import { recordTelemetry, type Recording } from "#test/support/telemetry";

let recording: Recording;

beforeEach(() => {
  recording = recordTelemetry();
});

afterEach(async () => {
  await recording.shutdown();
});

const counted = async (): Promise<Record<string, unknown>> => {
  const points = (await recording.metrics()).get("questify.log.events") ?? [];
  return Object.fromEntries(
    points.map((point) => [
      `${String(point.attributes["questify.event"])}:${String(point.attributes["questify.log.level"])}`,
      point.value,
    ]),
  );
};

describe("countLogEvent", () => {
  it("counts a named event once per line, by level", async () => {
    countLogEvent("push.notice_parked", "error");
    countLogEvent("push.notice_parked", "error");
    countLogEvent("push.notice_parked", "info");
    expect(await counted()).toEqual({
      "push.notice_parked:error": 2,
      "push.notice_parked:info": 1,
    });
  });

  it.each([42, undefined, null, {}, "", "Alice@example.sa", "no spaces.allowed here", "a.b.c.d"])(
    "does not count %j: it is not an event name",
    async (event) => {
      countLogEvent(event, "error");
      expect(await counted()).toEqual({});
    },
  );
});

describe("the log method hook", () => {
  const hook = logTelemetry().hooks.logMethod;

  function write(level: number, ...args: unknown[]): unknown[][] {
    const calls: unknown[][] = [];
    hook.call({}, args, (...received: unknown[]) => calls.push(received), level);
    return calls;
  }

  it("counts info, warn and error lines that name an event and still writes them unchanged", async () => {
    const written = [
      write(30, { event: "a.info" }, "m1"),
      write(40, { event: "a.warn" }),
      write(50, { event: "a.error" }),
      write(60, { event: "a.fatal" }),
    ];
    expect(written).toEqual([
      [[{ event: "a.info" }, "m1"]],
      [[{ event: "a.warn" }]],
      [[{ event: "a.error" }]],
      [[{ event: "a.fatal" }]],
    ]);
    expect(await counted()).toEqual({
      "a.info:info": 1,
      "a.warn:warn": 1,
      "a.error:error": 1,
      "a.fatal:error": 1,
    });
  });

  it("does not count debug lines, lines without an event, or lines that are only a message", async () => {
    write(20, { event: "a.debug" });
    write(30, { note: "no event" });
    write(30, "just a message");
    write(30, null);
    expect(await counted()).toEqual({});
  });
});
