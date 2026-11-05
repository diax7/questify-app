import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { unauthenticated } from "#src/auth/http-errors";
import { actorOf, organizerContextOf } from "#src/organizers/context";
import { teamSeat, type OrganizerPrincipal } from "#src/organizers/store";

const STAFF = "11111111-1111-4111-8111-111111111111";
const ORGANIZER = "22222222-2222-4222-8222-222222222222";

function requestOf(organizer: Partial<OrganizerPrincipal> = {}): FastifyRequest {
  return {
    staff: { account: { id: STAFF, email: "owner@example.com" }, sessionId: "s-1", tokenHash: "" },
    organizer: { id: ORGANIZER, role: "owner", eventScope: null, ...organizer },
  } as unknown as FastifyRequest;
}

describe("actorOf (the team's caller)", () => {
  it("names the caller, the organizer and the email", () => {
    expect(actorOf(requestOf())).toEqual({
      staffUserId: STAFF,
      organizerId: ORGANIZER,
      email: "owner@example.com",
    });
  });

  it("carries the support-view mark, so a seat built from the actor opens read-only", () => {
    const actor = actorOf(requestOf({ readOnly: true }));
    expect(actor.readOnly).toBe(true);
    expect(teamSeat(actor).readOnly).toBe(true);
  });

  it("has no mark for a member or an edit grant", () => {
    const actor = actorOf(requestOf());
    expect("readOnly" in actor).toBe(false);
    expect("readOnly" in teamSeat(actor)).toBe(false);
  });

  it("is unauthenticated when the scope's hook did not set the caller", () => {
    const bare = {} as unknown as FastifyRequest;
    expect(() => actorOf(bare)).toThrow(unauthenticated());
    expect(() => organizerContextOf(bare)).toThrow(unauthenticated());
  });
});
