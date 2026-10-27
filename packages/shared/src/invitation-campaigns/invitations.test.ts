import { describe, expect, it } from "vitest";
import {
  adminInvitationCampaignSchema,
  adminInvitationDetailSchema,
  adminInvitationQueueSchema,
  invitationApproveBodySchema,
  invitationApprovedSchema,
  invitationCampaignSchema,
  invitationCampaignsSchema,
  invitationCountSchema,
  invitationNoteBodySchema,
  invitationOpenBodySchema,
  invitationOpenSchema,
  invitationRequestBodySchema,
} from "#src/invitation-campaigns/invitations";

/*
 * Mutation note: the refine messages "each interest once" and "each channel once" are unobservable (the API answers
 * every refused body with the same invalid_request, auth/request.ts, and no client reads them), so emptying them is
 * equivalent.
 */

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
    { size: 100_000 },
    { size: 50, cityId: "x" },
    { size: 50, cityId: "x".repeat(40) },
    { size: 50, interests: ["sport", "tech", "music"] },
    { size: 50, interests: ["ab"] },
    { size: 50, interests: ["a-1"] },
    { size: 50, interests: ["a".repeat(30)] },
    { size: 50, history: "none" },
    { size: 50, history: "recent" },
    { size: 50, history: "own" },
    { size: 50, sendAfter: "2030-01-01T00:00:00+03:00" },
  ])("accepts %j", (body) => {
    expect(invitationRequestBodySchema.parse(body)).toMatchObject(body);
  });

  it.each([
    { size: 49 },
    { size: 100_001 },
    { size: 50.5 },
    { size: 50, cityId: "" },
    { size: 50, cityId: "x".repeat(41) },
    { size: 50, interests: ["sport", "tech", "music", "art"] },
    { size: 50, interests: ["sport", "sport"] },
    { size: 50, interests: ["a"] },
    { size: 50, interests: ["a".repeat(31)] },
    { size: 50, interests: ["Tech"] },
    { size: 50, interests: ["1tech"] },
    { size: 50, interests: ["-tech"] },
    { size: 50, interests: ["tech!"] },
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

  it("lists the event's campaigns with whether requests are open", () => {
    const list = { enabled: true, campaigns: [campaign] };
    expect(invitationCampaignsSchema.parse(list)).toEqual(list);
    expect(accepts(invitationCampaignsSchema, { campaigns: [campaign] })).toBe(false);
    expect(accepts(invitationCampaignsSchema, { ...list, total: 1 })).toBe(false);
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
    { cap: 100_000 },
    { note: null },
    { expectedNameAr: null, expectedNameEn: "Riyadh Festival" },
    { expectedNameAr: "x".repeat(200), expectedNameEn: "x".repeat(200) },
  ])("accepts %j", (over) => {
    expect(invitationApproveBodySchema.parse({ ...body, ...over })).toEqual({ ...body, ...over });
  });

  it("trims the note", () => {
    expect(invitationApproveBodySchema.parse({ ...body, note: "  Paid  " }).note).toBe("Paid");
  });

  it.each([
    { channels: [] },
    { channels: ["push"] },
    { channels: ["sms", "sms"] },
    { cap: 49 },
    { cap: 100_001 },
    { sendAt: "tomorrow" },
    { note: "" },
    { expectedNameAr: "x".repeat(201) },
    { expectedNameEn: "x".repeat(201) },
    { price: 100 },
  ])("refuses %j", (over) => {
    expect(accepts(invitationApproveBodySchema, { ...body, ...over })).toBe(false);
  });
});

describe("the note and the open token", () => {
  it("takes a note of 1 to 500 characters once trimmed", () => {
    expect(accepts(invitationNoteBodySchema, { note: "Not this month" })).toBe(true);
    expect(accepts(invitationNoteBodySchema, { note: "x".repeat(500) })).toBe(true);
    expect(invitationNoteBodySchema.parse({ note: ` ${"x".repeat(500)} ` })).toEqual({
      note: "x".repeat(500),
    });
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

const adminCampaign = {
  id: "44444444-4444-4444-8444-444444444444",
  state: "sending",
  endReason: null,
  organizer: { id: "55555555-5555-4555-8555-555555555555", name: "Riyadh Events" },
  event: {
    id: "66666666-6666-4666-8666-666666666666",
    joinCode: "RIYADH",
    name: { ar: "مهرجان الرياض", en: "Riyadh Festival" },
  },
  cityId: "sa-riyadh",
  interests: ["tech"],
  history: "none",
  size: 500,
  sendAfter: null,
  channels: ["sms"],
  cap: 400,
  sendAt: "2026-10-28T09:00:00+00:00",
  note: null,
  approvedNames: { ar: "مهرجان الرياض", en: null },
  requestedAt: "2026-10-27T09:00:00+00:00",
  decidedAt: "2026-10-27T10:00:00+00:00",
  startedAt: "2026-10-28T09:00:05+00:00",
  finishedAt: null,
  finalAt: null,
  publishedAt: null,
  counts: {
    planned: 400,
    sent: 120,
    unknown: 3,
    failed: 2,
    skipped: 1,
    cancelled: 0,
    opened: 15,
    joined: 4,
  },
};

describe("adminInvitationCampaignSchema", () => {
  it("carries exact counts and the frozen names, in the queue and in the approval's answer", () => {
    expect(adminInvitationCampaignSchema.parse(adminCampaign)).toEqual(adminCampaign);
    const queue = { campaigns: [adminCampaign] };
    expect(adminInvitationQueueSchema.parse(queue)).toEqual(queue);
    const approved = { campaign: adminCampaign, sendAtMoved: true };
    expect(invitationApprovedSchema.parse(approved)).toEqual(approved);
  });

  it.each([
    { counts: { ...adminCampaign.counts, sent: -1 } },
    { counts: { ...adminCampaign.counts, joined: 1.5 } },
    { counts: { ...adminCampaign.counts, published: 0 } },
    { organizer: { id: adminCampaign.organizer.id } },
    { event: { ...adminCampaign.event, joinCode: undefined } },
    { approvedNames: { ar: "مهرجان الرياض" } },
    { channels: ["push"] },
    { players: [] },
  ])("refuses %j", (over) => {
    expect(accepts(adminInvitationCampaignSchema, { ...adminCampaign, ...over })).toBe(false);
  });

  it("takes zero as an exact count", () => {
    const zero = Object.fromEntries(Object.keys(adminCampaign.counts).map((key) => [key, 0]));
    expect(accepts(adminInvitationCampaignSchema, { ...adminCampaign, counts: zero })).toBe(true);
  });
});

describe("adminInvitationDetailSchema", () => {
  const detail = {
    campaign: adminCampaign,
    eventIssue: null,
    eventEndsAt: "2026-11-01T20:00:00+03:00",
    names: {
      ar: { name: "مهرجان الرياض", issue: null },
      en: { name: null, issue: null },
    },
    messages: { ar: { text: "دعوة إلى مهرجان الرياض", parts: 2 }, en: null },
    estimate: 1200,
    queued: 7,
    availableChannels: ["sms"],
    hold: { channel: "sms", holdUntil: "2026-10-28T12:00:00+00:00", code: "1060" },
  };

  it.each([
    {},
    { hold: null, estimate: null, eventIssue: "ends_soon" },
    { estimate: 0, queued: 0 },
    { messages: { ar: null, en: { text: "Invitation", parts: 1 } } },
    { names: { ...detail.names, en: { name: "Riyadh Festival", issue: "control_characters" } } },
    { names: { ...detail.names, en: { name: "Riyadh Festival", issue: "looks_like_address" } } },
    { names: { ...detail.names, en: { name: "Riyadh Festival", issue: "looks_like_phone" } } },
  ])("accepts the detail with %j", (over) => {
    expect(adminInvitationDetailSchema.parse({ ...detail, ...over })).toEqual({
      ...detail,
      ...over,
    });
  });

  it.each([
    { names: { ...detail.names, en: { name: "x", issue: "looks_like_url" } } },
    { names: { ar: detail.names.ar } },
    { messages: { ar: { text: "دعوة", parts: 0 }, en: null } },
    { messages: { ar: null } },
    { estimate: -1 },
    { queued: -1 },
    { hold: { channel: "sms", holdUntil: "2026-10-28T12:00:00+00:00" } },
    { phones: [] },
  ])("refuses %j", (over) => {
    expect(accepts(adminInvitationDetailSchema, { ...detail, ...over })).toBe(false);
  });
});

describe("invitationOpenSchema", () => {
  const opened = {
    event: {
      id: "66666666-6666-4666-8666-666666666666",
      joinCode: "RIYADH",
      name: { ar: "مهرجان الرياض", en: "Riyadh Festival" },
      venue: { ar: null, en: null },
      kind: "festival",
      timezone: "Asia/Riyadh",
      startsAt: "2026-10-28T16:00:00+03:00",
      endsAt: null,
      statusNow: "live",
    },
  };

  it("is the public event card and never anything about the player", () => {
    expect(invitationOpenSchema.parse(opened)).toEqual(opened);
    expect(accepts(invitationOpenSchema, { event: { ...opened.event, player: "p" } })).toBe(false);
    expect(accepts(invitationOpenSchema, { ...opened, playerId: "p" })).toBe(false);
    expect(accepts(invitationOpenSchema, { event: { ...opened.event, venue: { ar: null } } })).toBe(
      false,
    );
  });
});
