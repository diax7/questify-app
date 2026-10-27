import { describe, expect, it } from "vitest";
import {
  invitationApproveBodySchema,
  invitationCampaignSchema,
  invitationCountSchema,
  invitationNoteBodySchema,
  invitationOpenBodySchema,
  invitationRequestBodySchema,
} from "#src/invitation-campaigns/invitations";

const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const campaign = {
  id: "44444444-4444-4444-8444-444444444444",
  state: "sent",
  endReason: null,
  cityId: "sa-jeddah",
  interests: ["tech"],
  history: "recent",
  size: 500,
  sendAfter: null,
  cap: 400,
  sendAt: "2026-10-28T09:00:00+00:00",
  note: null,
  requestedAt: "2026-10-27T09:00:00+00:00",
  decidedAt: "2026-10-27T10:00:00+00:00",
  startedAt: "2026-10-28T09:00:05+00:00",
  finishedAt: "2026-10-28T10:00:00+00:00",
  publishedAt: "2026-10-29T01:00:00+00:00",
  counts: { sent: { atLeast: 390 }, opened: { fewerThan: 10 }, joined: null },
};

describe("invitationRequestBodySchema", () => {
  it("fills the optional criteria with their defaults", () => {
    expect(invitationRequestBodySchema.parse({ size: 50 })).toEqual({
      cityId: null,
      interests: [],
      history: "none",
      size: 50,
      sendAfter: null,
    });
  });

  it.each([
    { size: 49 },
    { size: 100_001 },
    { size: 50.5 },
    { size: 50, interests: ["sport", "tech", "music", "art"] },
    { size: 50, interests: ["sport", "sport"] },
    { size: 50, history: "ever" },
    { size: 50, sendAfter: "2030-01-01T00:00:00" },
    { size: 50, playerIds: [] },
    { size: 50, message: "Come!" },
  ])("refuses %j", (body) => {
    expect(accepts(invitationRequestBodySchema, body)).toBe(false);
  });
});

describe("invitationCountSchema", () => {
  it.each([null, { fewerThan: 10 }, { atLeast: 10 }, { atLeast: 99_990 }])(
    "accepts %j",
    (count) => {
      expect(accepts(invitationCountSchema, count)).toBe(true);
    },
  );

  it.each([3, { fewerThan: 5 }, { atLeast: 15 }, { atLeast: 0 }, { atLeast: 10, exact: 12 }])(
    "refuses %j: an organizer never sees an exact count",
    (count) => {
      expect(accepts(invitationCountSchema, count)).toBe(false);
    },
  );
});

describe("invitationCampaignSchema", () => {
  it("is the organizer's view and nothing more", () => {
    expect(accepts(invitationCampaignSchema, campaign)).toBe(true);
    for (const extra of [{ planned: 400 }, { approvedNames: {} }, { players: [] }]) {
      expect(accepts(invitationCampaignSchema, { ...campaign, ...extra })).toBe(false);
    }
    expect(
      accepts(invitationCampaignSchema, { ...campaign, counts: { ...campaign.counts, sent: 393 } }),
    ).toBe(false);
  });
});

describe("invitationApproveBodySchema", () => {
  const body = {
    channels: ["sms"],
    cap: 100,
    sendAt: "2026-10-28T09:00:00+03:00",
    expectedNameAr: "مهرجان",
    expectedNameEn: null,
  };

  it("needs the names the console showed, possibly null", () => {
    expect(accepts(invitationApproveBodySchema, body)).toBe(true);
    expect(accepts(invitationApproveBodySchema, { ...body, note: "Paid" })).toBe(true);
    const { expectedNameEn: _left, ...missing } = body;
    expect(accepts(invitationApproveBodySchema, missing)).toBe(false);
  });

  it.each([
    { channels: [] },
    { channels: ["push"] },
    { channels: ["sms", "sms"] },
    { cap: 49 },
    { sendAt: "tomorrow" },
    { note: "" },
    { price: 100 },
  ])("refuses %j", (over) => {
    expect(accepts(invitationApproveBodySchema, { ...body, ...over })).toBe(false);
  });
});

describe("the note and the open token", () => {
  it("takes a note of 1 to 500 characters", () => {
    expect(accepts(invitationNoteBodySchema, { note: "Not this month" })).toBe(true);
    expect(accepts(invitationNoteBodySchema, { note: "   " })).toBe(false);
    expect(accepts(invitationNoteBodySchema, { note: "x".repeat(501) })).toBe(false);
  });

  it("takes only a 22-character base64url token", () => {
    expect(accepts(invitationOpenBodySchema, { token: "A".repeat(22) })).toBe(true);
    for (const token of ["A".repeat(21), "A".repeat(23), `${"A".repeat(21)}+`, 5]) {
      expect(accepts(invitationOpenBodySchema, { token })).toBe(false);
    }
  });
});
