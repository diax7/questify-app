import { describe, expect, it } from "vitest";
import {
  approveCampaign,
  availableChannels,
  campaignDetail,
  eventNameProblem,
  openInvitation,
  refusalOf,
} from "#src/invitation-campaigns/campaigns";
import { invalidApproval, invalidInvitation } from "#src/auth/http-errors";
import type { SmsSender } from "#src/players/sms";
import { fakePool, pgError } from "#test/support/fake-pool";

const SENDER: SmsSender = { name: "promo", send: async () => ({ kind: "sent" }) };
const ADMIN = "33333333-3333-4333-8333-333333333333";
const CAMPAIGN = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";
const STAMP = "2026-10-27T09:00:00+00:00";

const campaignJson = {
  id: CAMPAIGN,
  state: "approved",
  endReason: null,
  organizer: { id: EVENT, name: "Najd Events" },
  event: { id: EVENT, joinCode: "QFY1", name: { ar: "مهرجان", en: "Festival" } },
  cityId: null,
  interests: [],
  history: "none",
  size: 100,
  sendAfter: null,
  channels: ["sms"],
  cap: 100,
  sendAt: STAMP,
  note: null,
  approvedNames: { ar: "مهرجان", en: "Festival" },
  requestedAt: STAMP,
  decidedAt: STAMP,
  startedAt: null,
  finishedAt: null,
  finalAt: null,
  publishedAt: null,
  counts: {
    planned: 0,
    sent: 0,
    unknown: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    opened: 0,
    joined: 0,
  },
};

const approval = (over: Record<string, unknown> = {}) => ({
  channels: ["sms" as const],
  cap: 100,
  sendAt: "2026-10-27T23:30:00+03:00",
  expectedNameAr: "مهرجان",
  expectedNameEn: "Festival",
  ...over,
});

describe("refusalOf", () => {
  it.each([
    [{ code: "IV404" }, 404, "not_found"],
    [{ code: "QY403" }, 404, "not_found"],
    [{ code: "IV403", detail: "owner_only" }, 403, "owner_only"],
    [{ code: "IV403", detail: "feature_off" }, 403, "feature_off"],
    [{ code: "IV409", detail: "wrong_state" }, 409, "wrong_state"],
    [{ code: "IV409", detail: "invitation_open" }, 409, "invitation_open"],
    [{ code: "IV409", detail: "event_renamed" }, 409, "event_renamed"],
    [{ code: "IV409", detail: "idempotency_mismatch" }, 409, "idempotency_mismatch"],
    [{ code: "IV409", detail: "event_not_eligible", hint: "link_off" }, 409, "event_not_eligible"],
    [
      { code: "IV422", detail: "event_not_eligible", hint: "not_public" },
      422,
      "event_not_eligible",
    ],
    [{ code: "IV422", detail: "size" }, 422, "invalid_invitation"],
  ])("maps %j to %i %s", (fields, status, code) => {
    expect(() => refusalOf(pgError(fields), invalidInvitation)).toThrow(
      expect.objectContaining({ status, envelope: expect.objectContaining({ code }) }),
    );
  });

  it("carries the reason and the field in the details", () => {
    expect(() =>
      refusalOf(
        pgError({ code: "IV409", detail: "event_not_eligible", hint: "ends_soon" }),
        invalidInvitation,
      ),
    ).toThrow(
      expect.objectContaining({
        envelope: expect.objectContaining({ details: { reason: "ends_soon" } }),
      }),
    );
    expect(() => refusalOf(pgError({ code: "IV422", detail: "cap" }), invalidApproval)).toThrow(
      expect.objectContaining({
        envelope: expect.objectContaining({ code: "invalid_approval", details: { field: "cap" } }),
      }),
    );
  });

  it.each([
    { code: "IV403", detail: "system_only" },
    { code: "IV409", detail: "something_new" },
    { code: "IV409", detail: "constructor" },
    { code: "42501" },
  ])("rethrows %j as a server fault", (fields) => {
    const fault = pgError(fields);
    expect(() => refusalOf(fault, invalidInvitation)).toThrow(fault);
  });
});

describe("eventNameProblem", () => {
  it("names the first language whose name the SMS cannot carry, and skips a blank one", () => {
    expect(eventNameProblem({ ar: "مهرجان", en: "Festival" })).toBeNull();
    expect(eventNameProblem({ ar: null, en: "  " })).toBeNull();
    expect(eventNameProblem({ ar: "اتصل 0501234567", en: "pay.now" })).toEqual({
      language: "ar",
      reason: "looks_like_phone",
    });
    expect(eventNameProblem({ ar: null, en: "Tech‮Week" })).toEqual({
      language: "en",
      reason: "control_characters",
    });
  });
});

describe("availableChannels", () => {
  it("offers SMS only with the promotional sender, push only with a push provider", () => {
    expect(availableChannels({})).toEqual([]);
    expect(availableChannels({ promoSms: SENDER })).toEqual(["sms"]);
    expect(availableChannels({ pushReady: true })).toEqual(["push"]);
    expect(availableChannels({ pushReady: false, promoSms: SENDER })).toEqual(["sms"]);
    expect(availableChannels({ pushReady: true, promoSms: SENDER })).toEqual(["push", "sms"]);
  });
});

describe("approveCampaign", () => {
  it("refuses SMS without a promotional sender, before the database", async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ r: campaignJson }] }));
    await expect(
      approveCampaign({ pool }, ADMIN, {
        campaignId: CAMPAIGN,
        body: approval(),
        requestId: CAMPAIGN,
      }),
    ).rejects.toMatchObject({
      status: 422,
      envelope: { code: "channel_unavailable", details: { channel: "sms" } },
    });
    expect(queries).toEqual([]);
  });

  it("refuses push without a push provider, before the database", async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ r: campaignJson }] }));
    await expect(
      approveCampaign({ pool, promoSms: SENDER }, ADMIN, {
        campaignId: CAMPAIGN,
        body: approval({ channels: ["push", "sms"] }),
        requestId: CAMPAIGN,
      }),
    ).rejects.toMatchObject({
      status: 422,
      envelope: { code: "channel_unavailable", details: { channel: "push" } },
    });
    expect(queries).toEqual([]);
  });

  it("keeps a push-only send time inside quiet hours (they are SMS's alone)", async () => {
    const seen: (readonly unknown[])[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return { rows: [{ r: campaignJson }] };
    });
    const answer = await approveCampaign({ pool, pushReady: true }, ADMIN, {
      campaignId: CAMPAIGN,
      body: approval({ channels: ["push"] }),
      requestId: CAMPAIGN,
    });
    expect(answer.sendAtMoved).toBe(false);
    expect(seen[0]?.[1]).toEqual(["push"]);
    expect(seen[0]?.[3]).toEqual(new Date(approval().sendAt));
    const both = await approveCampaign({ pool, pushReady: true, promoSms: SENDER }, ADMIN, {
      campaignId: CAMPAIGN,
      body: approval({ channels: ["push", "sms"] }),
      requestId: CAMPAIGN,
    });
    expect(both.sendAtMoved).toBe(true);
  });

  it("refuses names the SMS cannot carry, before the database", async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ r: campaignJson }] }));
    await expect(
      approveCampaign({ pool, promoSms: SENDER }, ADMIN, {
        campaignId: CAMPAIGN,
        body: approval({ expectedNameEn: "visit pay-now.co" }),
        requestId: CAMPAIGN,
      }),
    ).rejects.toMatchObject({
      status: 422,
      envelope: { code: "event_name", details: { language: "en", reason: "looks_like_address" } },
    });
    expect(queries).toEqual([]);
  });

  it("moves a send time out of quiet hours and says so, sending the names as the console showed them", async () => {
    const seen: (readonly unknown[])[] = [];
    const { pool } = fakePool((_sql, values) => {
      seen.push(values);
      return { rows: [{ r: campaignJson }] };
    });
    const answer = await approveCampaign({ pool, promoSms: SENDER }, ADMIN, {
      campaignId: CAMPAIGN,
      body: approval(),
      requestId: CAMPAIGN,
    });
    expect(answer.sendAtMoved).toBe(true);
    expect(seen[0]).toEqual([
      CAMPAIGN,
      ["sms"],
      100,
      new Date("2026-10-28T09:00:00+03:00"),
      null,
      "مهرجان",
      "Festival",
      CAMPAIGN,
    ]);
    const kept = await approveCampaign({ pool, promoSms: SENDER }, ADMIN, {
      campaignId: CAMPAIGN,
      body: approval({ sendAt: "2026-10-27T14:00:00+03:00", note: "Paid" }),
      requestId: CAMPAIGN,
    });
    expect(kept.sendAtMoved).toBe(false);
    expect(seen[1]?.[4]).toBe("Paid");
  });

  it("answers 500 rather than pass a field the console's schema does not know", async () => {
    const { pool } = fakePool(() => ({
      rows: [{ r: { ...campaignJson, phone: "+966500000000" } }],
    }));
    await expect(
      approveCampaign({ pool, promoSms: SENDER }, ADMIN, {
        campaignId: CAMPAIGN,
        body: approval({ sendAt: "2026-10-27T14:00:00+03:00" }),
        requestId: CAMPAIGN,
      }),
    ).rejects.toThrow();
  });
});

const detailOf = (
  campaign: Record<string, unknown>,
  names: { ar: string | null; en: string | null },
) => {
  const { pool } = fakePool(() => ({
    rows: [
      {
        r: {
          campaign: { ...campaignJson, ...campaign },
          eventIssue: null,
          eventEndsAt: STAMP,
          names,
          estimate: null,
          queued: 0,
          hold: null,
        },
      },
    ],
  }));
  return campaignDetail({ pool, promoSms: SENDER }, ADMIN, CAMPAIGN);
};

describe("campaignDetail", () => {
  it("adds the name rule's verdicts, the rendered messages and the channels to the door's answer", async () => {
    const { pool } = fakePool(() => ({
      rows: [
        {
          r: {
            campaign: campaignJson,
            eventIssue: null,
            eventEndsAt: STAMP,
            names: { ar: "مهرجان", en: "call 0501234567" },
            estimate: 120,
            queued: 0,
            hold: null,
          },
        },
      ],
    }));
    const detail = await campaignDetail({ pool, promoSms: SENDER }, ADMIN, CAMPAIGN);
    expect(detail.names).toEqual({
      ar: { name: "مهرجان", issue: null },
      en: { name: "call 0501234567", issue: "looks_like_phone" },
    });
    expect(detail.messages.ar?.text.startsWith("دعوة إلى مهرجان: ")).toBe(true);
    expect(detail.messages.en?.parts).toBeLessThanOrEqual(3);
    expect(detail.availableChannels).toEqual(["sms"]);
    expect(detail.pushMessages.ar).toEqual({ title: "مهرجان", body: "لديك دعوة إلى مهرجان." });
    expect(detail.pushMessages.en).toEqual({
      title: "Festival",
      body: "You have an invitation to Festival.",
    });
  });

  it("leaves out of the push a name the rule refuses, as the worker renders it", async () => {
    const detail = await detailOf(
      { state: "requested", approvedNames: { ar: null, en: null } },
      { ar: null, en: "call 0501234567" },
    );
    expect(detail.pushMessages.en).toEqual({
      title: "Questify",
      body: "You have an invitation to an event.",
    });
  });

  it("renders a requested campaign's messages from the event's current names", async () => {
    const detail = await detailOf(
      { state: "requested", approvedNames: { ar: null, en: null } },
      { ar: "اسم جديد", en: "New name" },
    );
    expect(detail.messages.ar?.text.startsWith("دعوة إلى اسم جديد: ")).toBe(true);
    expect(detail.messages.en?.text.startsWith("Invitation to New name: ")).toBe(true);
    expect(detail.pushMessages.en).toEqual({
      title: "New name",
      body: "You have an invitation to New name.",
    });
  });

  it.each(["approved", "sending", "sent", "cancelled"])(
    "renders a %s campaign's messages from the frozen names, whatever the event is called now",
    async (state) => {
      const detail = await detailOf({ state }, { ar: "اسم جديد", en: "New name" });
      expect(detail.names.en.name).toBe("New name");
      expect(detail.messages.ar?.text.startsWith("دعوة إلى مهرجان: ")).toBe(true);
      expect(detail.messages.en?.text.startsWith("Invitation to Festival: ")).toBe(true);
    },
  );

  it("has no text for a campaign cancelled before it was approved", async () => {
    const detail = await detailOf(
      { state: "cancelled", endReason: "owner", approvedNames: { ar: null, en: null } },
      { ar: "مهرجان", en: "Festival" },
    );
    expect(detail.messages).toEqual({ ar: null, en: null });
    expect(detail.pushMessages).toEqual({ ar: null, en: null });
    expect(detail.names.en.name).toBe("Festival");
  });

  it("has no text for a campaign that was never approved", async () => {
    const detail = await detailOf(
      { state: "refused", approvedNames: { ar: null, en: null } },
      { ar: "مهرجان", en: "Festival" },
    );
    expect(detail.messages).toEqual({ ar: null, en: null });
  });
});

describe("openInvitation", () => {
  it("refuses a token that does not decode to a link, before the database", async () => {
    const { pool, queries } = fakePool(() => ({ rows: [] }));
    await expect(openInvitation(pool, "!!")).rejects.toMatchObject({ status: 400 });
    expect(queries).toEqual([]);
  });

  it("answers invitation_ended when the door finds nothing", async () => {
    const { pool } = fakePool(() => ({ rows: [{ r: null }] }));
    await expect(openInvitation(pool, "AAAAAAAAAAAAAAAAAAAAAA")).rejects.toMatchObject({
      status: 404,
      envelope: { code: "invitation_ended" },
    });
  });
});
