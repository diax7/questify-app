import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { joinEvent } from "#src/join/join-api.ts";

const headers = new Headers();
const MESSAGE = { ar: "م", en: "M" };
const CARD = {
  version: "0.2",
  title: { ar: "سيرى", en: "Will see" },
  receives: [{ ar: "الاسم", en: "Name" }],
  nameNotice: null,
};
const JOIN = { code: "ABC234", via: "public_list", cardVersion: "0.1" } as const;

const fail = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details,
  headers,
});
const okWith = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const outcome = (answer: AuthedResult) => joinEvent({ request: async () => answer }, JOIN);

describe("the join outcome, edge by edge", () => {
  it("reads a stale answer without a usable card as a plain refusal", async () => {
    for (const details of [{}, { card: "x" }, { card: { version: "0.2" } }]) {
      expect(await outcome(fail(409, "card_version_stale", details))).toEqual({
        kind: "refused",
        code: "card_version_stale",
        problem: MESSAGE,
      });
    }
    expect(await outcome(fail(409, "card_version_stale", { card: CARD }))).toEqual({
      kind: "stale",
      card: CARD,
    });
    expect(await outcome(fail(409, "other", { card: CARD }))).toMatchObject({ kind: "refused" });
  });

  it("points at a field only when the API names it as text", async () => {
    expect(await outcome(fail(422, "invalid_join_answers", { field: 4 }))).toEqual({
      kind: "invalid_answers",
      field: null,
      problem: MESSAGE,
    });
    expect(await outcome(fail(422, "invalid_join_answers", { field: "f2", card: CARD }))).toEqual({
      kind: "invalid_answers",
      field: "f2",
      problem: MESSAGE,
    });
  });

  it("reads the joined body strictly", async () => {
    expect(await outcome(okWith({ eventId: 5 }))).toEqual({ kind: "network" });
    expect(await outcome(okWith(null))).toEqual({ kind: "network" });
    expect(await outcome(okWith("joined"))).toEqual({ kind: "network" });
    expect(await outcome(okWith({ eventId: "e1", status: "weird", alreadyMember: "yes" }))).toEqual(
      {
        kind: "joined",
        eventId: "e1",
        status: "active",
        alreadyMember: false,
        welcome: 0,
        waitlisted: false,
      },
    );
    expect(
      await outcome(okWith({ eventId: "e1", status: "pending", waitlisted: "yes", welcome: 7 })),
    ).toMatchObject({ status: "pending", waitlisted: false, welcome: 7 });
    expect(await outcome({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(await outcome({ kind: "network" })).toEqual({ kind: "network" });
  });
});
