import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { checkInPlayer, doorResultOf, fetchDoorSessions } from "#src/operator/session-door.ts";

const ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const error = (code: string, status = 403): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers,
});
const requester = (answer: AuthedResult) => ({
  request: vi.fn(async (_request: unknown) => answer),
});
const player = { username: "sara", avatar: "fox" };

describe("doorResultOf", () => {
  it("shows each outcome in its colour with who was scanned", () => {
    const cases = [
      ["checked_in", "green", "door.checkedIn"],
      ["already", "orange", "door.already"],
      ["not_registered", "red", "door.notRegistered"],
      ["too_early", "red", "door.tooEarly"],
      ["ended", "red", "door.ended"],
    ] as const;
    for (const [result, color, message] of cases) {
      expect(doorResultOf({ result, walkIn: false, player })).toEqual({
        color,
        message,
        username: "sara",
      });
    }
  });

  it("says a walk-in in its own words, and only for a check-in", () => {
    expect(doorResultOf({ result: "checked_in", walkIn: true, player })?.message).toBe(
      "door.walkIn",
    );
    expect(doorResultOf({ result: "already", walkIn: true, player })?.message).toBe("door.already");
  });

  it("shows a refusal in red, with the code's own words for a code that cannot be read", () => {
    expect(doorResultOf({ result: "refused", reason: "invalid_code", player: null })).toEqual({
      color: "red",
      message: "door.invalid",
      username: null,
    });
    expect(doorResultOf({ result: "refused", reason: "old_code", player: null })?.message).toBe(
      "door.invalid",
    );
    expect(doorResultOf({ result: "refused", reason: "ability_off", player: null })?.message).toBe(
      "door.refused",
    );
    expect(doorResultOf({ result: "refused" })?.message).toBe("door.refused");
  });

  it("does not guess at an answer it does not know", () => {
    expect(doorResultOf({ result: "maybe" })).toBeNull();
    expect(doorResultOf({ nothing: true })).toBeNull();
    expect(doorResultOf(undefined)).toBeNull();
  });
});

describe("fetchDoorSessions", () => {
  const row = {
    id: ID,
    kind: "workshop",
    title: { ar: null, en: "Clay" },
    startsAt: "2030-11-01T07:00:00.000Z",
    endsAt: "2030-11-01T08:00:00.000Z",
    access: "registration",
    walkIns: true,
  };

  it("reads the sessions the door can check in to", async () => {
    const api = requester(ok({ sessions: [row] }));
    expect(await fetchDoorSessions(api, ID)).toMatchObject({
      kind: "sessions",
      sessions: [{ id: ID, walkIns: true }],
    });
    expect(api.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/operator/events/${ID}/sessions`,
    });
  });

  it("tells a removed operator from a sign-out and a bad connection", async () => {
    expect((await fetchDoorSessions(requester(error("not_operator")), ID)).kind).toBe("removed");
    expect((await fetchDoorSessions(requester({ kind: "signed_out" }), ID)).kind).toBe(
      "signed_out",
    );
    expect((await fetchDoorSessions(requester({ kind: "network" }), ID)).kind).toBe("network");
    expect((await fetchDoorSessions(requester(error("ability_off")), ID)).kind).toBe("network");
    expect((await fetchDoorSessions(requester(ok({ sessions: [{ id: 3 }] })), ID)).kind).toBe(
      "network",
    );
  });
});

describe("checkInPlayer", () => {
  it("sends the scanned code and returns the colour", async () => {
    const api = requester(ok({ result: "checked_in", walkIn: false, player }));
    const answer = await checkInPlayer(api, ID, "code-1");
    expect(answer).toEqual({
      kind: "result",
      result: { color: "green", message: "door.checkedIn", username: "sara" },
    });
    expect(api.request).toHaveBeenCalledWith({
      method: "POST",
      path: `/v1/operator/sessions/${ID}/check-in`,
      body: { code: "code-1" },
    });
  });

  it("leaves operator mode for a removed operator and calls an unreadable answer a network problem", async () => {
    expect((await checkInPlayer(requester(error("not_operator")), ID, "c")).kind).toBe("removed");
    expect((await checkInPlayer(requester(ok({ result: "?" })), ID, "c")).kind).toBe("network");
    expect((await checkInPlayer(requester({ kind: "network" }), ID, "c")).kind).toBe("network");
  });
});
