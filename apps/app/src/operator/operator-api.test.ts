import { describe, expect, it } from "vitest";
import {
  fetchStationToday,
  practiceScanPlayer,
  scanFor,
  scanPlayer,
} from "#src/operator/operator-api.ts";

const ok = (body: unknown) => ({ kind: "ok" as const, status: 200, body, headers: new Headers() });
const error = (status: number, code: string) => ({
  kind: "error" as const,
  status,
  code,
  message: { ar: "م", en: "m" },
  details: {},
  headers: new Headers(),
});
const recording = (answer: unknown) => {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    session: {
      request: async (request: Record<string, unknown>) => {
        sent.push(request);
        return answer as ReturnType<typeof ok>;
      },
    },
  };
};

const SCAN = { questId: "q1", code: "c".repeat(50), idempotencyKey: "k1" };
const GREEN = { result: "completed", points: 25, occurrence: 1, player: null };

describe("scanFor (ADR-249: the one place the station picks its door)", () => {
  it("posts only to the practice route with no key when practice is on", async () => {
    const { sent, session } = recording(ok({ ...GREEN, practice: true }));
    expect(scanFor(true)).toBe(practiceScanPlayer);
    const answer = await scanFor(true)(session, SCAN);
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/operator/scan/practice",
        body: { questId: "q1", code: SCAN.code },
      },
    ]);
    expect(answer).toEqual({
      kind: "result",
      result: { color: "green", points: 25, player: null },
      practice: true,
    });
  });

  it("posts only to the real route with its key when practice is off", async () => {
    const { sent, session } = recording(ok(GREEN));
    expect(scanFor(false)).toBe(scanPlayer);
    const answer = await scanFor(false)(session, SCAN);
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/operator/scan",
        body: { questId: "q1", code: SCAN.code },
        headers: { "idempotency-key": "k1" },
      },
    ]);
    expect(answer).toMatchObject({ kind: "result", practice: false });
  });

  it("takes the practice line from the server's answer, never from the switch (CTO MAJOR-1)", async () => {
    expect(await practiceScanPlayer(recording(ok(GREEN)).session, SCAN)).toMatchObject({
      practice: false,
    });
    expect(
      await scanPlayer(recording(ok({ ...GREEN, practice: true })).session, SCAN),
    ).toMatchObject({ practice: true });
  });

  it("answers removed for not_operator and reads a practice red", async () => {
    expect(await practiceScanPlayer(recording(error(403, "not_operator")).session, SCAN)).toEqual({
      kind: "removed",
    });
    const red = await practiceScanPlayer(
      recording(ok({ result: "refused", reason: "going_live", player: null, practice: true }))
        .session,
      SCAN,
    );
    expect(red).toEqual({
      kind: "result",
      result: { color: "red", reason: "operator.red.goingLive", player: null },
      practice: true,
    });
  });
});

describe("fetchStationToday (FR-928)", () => {
  it("reads the two counts from the station's path", async () => {
    const { sent, session } = recording(ok({ today: 40, lastHour: 6 }));
    expect(await fetchStationToday(session, "e 1", "q1")).toEqual({
      kind: "counts",
      counts: { today: 40, lastHour: 6 },
    });
    expect(sent).toEqual([{ method: "GET", path: "/v1/operator/events/e%201/stations/q1/today" }]);
  });

  it("answers removed, a refusal, or network for a body it cannot read", async () => {
    expect(
      await fetchStationToday(recording(error(403, "not_operator")).session, "e", "q"),
    ).toEqual({ kind: "removed" });
    expect(
      await fetchStationToday(recording(error(403, "outside_quests")).session, "e", "q"),
    ).toMatchObject({ kind: "refused", code: "outside_quests" });
    expect(await fetchStationToday(recording(ok({ today: "4" })).session, "e", "q")).toEqual({
      kind: "network",
    });
    expect(await fetchStationToday(recording({ kind: "network" }).session, "e", "q")).toEqual({
      kind: "network",
    });
  });
});
