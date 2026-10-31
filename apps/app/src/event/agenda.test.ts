import type { MemberSession } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import {
  cancelRegistration,
  fetchAgenda,
  noteKeyOf,
  offerOf,
  registerFor,
  seatsLeftOf,
  shownSessions,
  statusKeyOf,
} from "#src/event/agenda.ts";

const ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const OTHER = "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f";
const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const refused = (message: { ar: string; en: string } | null): AuthedResult => ({
  kind: "error",
  status: 409,
  code: "session_full",
  message,
  details: {},
  headers,
});
const requester = (answer: AuthedResult) => ({
  request: vi.fn(async (_request: unknown) => answer),
});

const session = (over: Partial<MemberSession> = {}): MemberSession => ({
  id: ID,
  kind: "talk",
  title: { ar: "الافتتاح", en: "Opening" },
  description: { ar: null, en: null },
  place: { ar: null, en: "Hall" },
  speakers: [],
  startsAt: "2030-11-01T07:00:00.000Z",
  endsAt: "2030-11-01T08:00:00.000Z",
  access: "registration",
  seats: 10,
  seatsLeft: 4,
  points: 0,
  registered: false,
  checkedIn: false,
  started: false,
  cancellable: false,
  status: "available",
  quest: null,
  ...over,
});

describe("fetchAgenda", () => {
  it("reads the sessions the API sent", async () => {
    const read = await fetchAgenda(requester(ok({ sessions: [session()] })), ID);
    expect(read).toMatchObject({ kind: "agenda", sessions: [{ id: ID }] });
  });

  it("calls a body it cannot read, a refusal and a dropped connection a network problem", async () => {
    expect((await fetchAgenda(requester(ok({ sessions: [{ id: 1 }] })), ID)).kind).toBe("network");
    expect((await fetchAgenda(requester(refused(null)), ID)).kind).toBe("network");
    expect((await fetchAgenda(requester({ kind: "network" }), ID)).kind).toBe("network");
  });

  it("passes on a signed-out session", async () => {
    expect((await fetchAgenda(requester({ kind: "signed_out" }), ID)).kind).toBe("signed_out");
  });
});

describe("registerFor", () => {
  it("sends the key and the confirmation, and reports a registration", async () => {
    const api = requester(ok({ outcome: "registered", replayed: false }));
    const act = await registerFor(api, ID, OTHER, { confirmOverlap: true, idempotencyKey: "k-1" });
    expect(act).toEqual({ kind: "registered" });
    expect(api.request).toHaveBeenCalledWith({
      method: "POST",
      path: `/v1/events/${ID}/sessions/${OTHER}/register`,
      body: { confirmOverlap: true },
      headers: { "idempotency-key": "k-1" },
    });
  });

  it("asks without confirming first, and returns the overlapping titles in both languages", async () => {
    const api = requester(
      ok({
        outcome: "overlap",
        overlaps: [{ id: OTHER, title: { ar: "ورشة", en: null } }],
      }),
    );
    const act = await registerFor(api, ID, OTHER, { confirmOverlap: false, idempotencyKey: "k-2" });
    expect(act).toEqual({ kind: "overlap", titles: [{ ar: "ورشة", en: "ورشة" }] });
    expect(api.request.mock.calls[0]?.[0]).toMatchObject({ body: {} });
  });

  it("returns the API's own words for a refusal and tells network from sign-out", async () => {
    const words = { ar: "اكتملت المقاعد.", en: "This session is full." };
    const options = { confirmOverlap: false, idempotencyKey: "k-3" };
    expect(await registerFor(requester(refused(words)), ID, OTHER, options)).toEqual({
      kind: "refused",
      message: words,
    });
    expect((await registerFor(requester({ kind: "network" }), ID, OTHER, options)).kind).toBe(
      "network",
    );
    expect((await registerFor(requester({ kind: "signed_out" }), ID, OTHER, options)).kind).toBe(
      "signed_out",
    );
    expect((await registerFor(requester(ok({ outcome: "?" })), ID, OTHER, options)).kind).toBe(
      "network",
    );
  });
});

describe("cancelRegistration", () => {
  it("reports a cancelled seat and a refusal", async () => {
    expect(
      await cancelRegistration(requester(ok({ status: "cancelled" })), ID, OTHER, "k"),
    ).toEqual({ kind: "cancelled" });
    expect((await cancelRegistration(requester(refused(null)), ID, OTHER, "k")).kind).toBe(
      "refused",
    );
  });
});

describe("what a session offers", () => {
  it("offers registering only while a seat is free and registration is open", () => {
    expect(offerOf(session())).toBe("register");
    expect(offerOf(session({ status: "full" }))).toBe("full");
    expect(offerOf(session({ status: "closed" }))).toBe("closed");
    expect(offerOf(session({ started: true, status: "closed" }))).toBe("started");
    expect(offerOf(session({ access: "open", status: "open" }))).toBe("none");
  });

  it("offers cancelling only to a registered player before the start", () => {
    expect(offerOf(session({ registered: true, cancellable: true, status: "registered" }))).toBe(
      "cancel",
    );
    expect(offerOf(session({ registered: true, cancellable: false, status: "registered" }))).toBe(
      "none",
    );
  });

  it("names where the player stands, why there is no button, and the seats left", () => {
    expect(statusKeyOf(session({ checkedIn: true, registered: true }))).toBe("agenda.checkedIn");
    expect(statusKeyOf(session({ registered: true }))).toBe("agenda.registered");
    expect(statusKeyOf(session({ access: "open" }))).toBe("agenda.open");
    expect(statusKeyOf(session())).toBeNull();
    expect(noteKeyOf(session({ status: "full" }))).toBe("agenda.full");
    expect(noteKeyOf(session({ status: "closed" }))).toBe("agenda.closed");
    expect(noteKeyOf(session({ started: true }))).toBe("agenda.started");
    expect(noteKeyOf(session())).toBeNull();
    expect(seatsLeftOf(session())).toBe(4);
    expect(seatsLeftOf(session({ registered: true }))).toBeNull();
    expect(seatsLeftOf(session({ seatsLeft: null }))).toBeNull();
  });

  it("shows all sessions or only the registered ones", () => {
    const rows = [session(), session({ id: OTHER, registered: true })];
    expect(shownSessions(rows, false)).toHaveLength(2);
    expect(shownSessions(rows, true).map((row) => row.id)).toEqual([OTHER]);
    expect(shownSessions(undefined, true)).toEqual([]);
  });
});
