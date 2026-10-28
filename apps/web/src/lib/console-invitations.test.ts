import { describe, expect, it } from "vitest";
import {
  approvalBlock,
  approvalBodyOf,
  approvalDraftOf,
  approvalRefusalText,
  detailFailure,
  invitationPath,
  isCampaignId,
  isOpen,
  isRenamed,
  readApproved,
  readDetail,
  readQueue,
  waitingCount,
} from "#src/lib/console-invitations.ts";
import { translatorFor } from "#src/lib/language.ts";

const en = translatorFor("en");
const ID = "44444444-4444-4444-8444-444444444444";
const STAMP = "2026-10-27T09:00:00+00:00";

const counts = {
  planned: 0,
  sent: 0,
  unknown: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
  opened: 0,
  joined: 0,
};

const campaign = {
  id: ID,
  state: "requested",
  endReason: null,
  organizer: { id: ID, name: "Najd Events" },
  event: { id: ID, joinCode: "QFY1", name: { ar: "مهرجان", en: "Festival" } },
  cityId: null,
  interests: [],
  history: "none",
  size: 500,
  sendAfter: null,
  channels: null,
  cap: null,
  sendAt: null,
  note: null,
  approvedNames: { ar: null, en: null },
  requestedAt: STAMP,
  decidedAt: null,
  startedAt: null,
  finishedAt: null,
  finalAt: null,
  publishedAt: null,
  counts,
};

const rendered = { text: "دعوة إلى مهرجان: https://q/ar/i#x", parts: 1 };
const detail = {
  campaign,
  eventIssue: null,
  eventEndsAt: "2026-11-05T09:00:00+00:00",
  names: {
    ar: { name: "مهرجان", issue: null },
    en: { name: "Festival", issue: null },
  },
  messages: { ar: rendered, en: { ...rendered, text: "Invitation to Festival: https://q/en/i#x" } },
  pushMessages: {
    ar: { title: "مهرجان", body: "لديك دعوة إلى مهرجان." },
    en: { title: "Festival", body: "You have an invitation to Festival." },
  },
  estimate: 120,
  queued: 0,
  availableChannels: ["sms"],
  hold: null,
};

const parsed = readDetail(detail);
if (parsed === undefined) throw new Error("the fixture must be a valid detail");

const queued = (state: string) => readQueue({ campaigns: [{ ...campaign, state }] })?.[0];

const blockOf = (change: object) => {
  const changed = readDetail({ ...detail, ...change });
  return changed === undefined ? "invalid fixture" : approvalBlock(changed);
};

const answerOf = (code: string, details: object = {}) => ({ code, details });

describe("the readers", () => {
  it("read the queue, the detail and the approval as the API sends them", () => {
    expect(readQueue({ campaigns: [campaign] })?.[0]?.organizer.name).toBe("Najd Events");
    expect(readDetail(detail)?.estimate).toBe(120);
    expect(readApproved({ campaign, sendAtMoved: true })?.sendAtMoved).toBe(true);
  });

  it.each([
    ["a queue without the key", () => readQueue({})],
    ["a queue row with a player", () => readQueue({ campaigns: [{ ...campaign, players: [] }] })],
    ["a detail without the messages", () => readDetail({ ...detail, messages: undefined })],
    ["an approval without the flag", () => readApproved({ campaign })],
    ["no body", () => readDetail(undefined)],
  ])("refuse %s", (_name, read) => {
    expect(read()).toBeUndefined();
  });
});

describe("detailFailure", () => {
  it("says the page could not load after a dropped connection, a server fault or an unreadable answer", () => {
    expect(detailFailure({ ok: false, status: 0, body: undefined })).toBe("failed");
    expect(detailFailure({ ok: false, status: 502, body: undefined })).toBe("failed");
    expect(detailFailure({ ok: false, status: 503, body: { code: "unavailable" } })).toBe("failed");
    expect(detailFailure({ ok: true, status: 200, body: { campaign: 1 } })).toBe("failed");
  });

  it("says there is no such request when the API answered that", () => {
    expect(detailFailure({ ok: false, status: 404, body: { code: "not_found" } })).toBe("missing");
    expect(detailFailure({ ok: false, status: 400, body: undefined })).toBe("missing");
  });
});

describe("isCampaignId and the path", () => {
  it("only lets a UUID reach an API path", () => {
    expect(isCampaignId(ID)).toBe(true);
    for (const bad of ["", "../x", `${ID}/approve`, "4444", "g".repeat(36)]) {
      expect(isCampaignId(bad)).toBe(false);
    }
    expect(invitationPath(ID)).toBe(`/v1/admin/invitation-campaigns/${ID}`);
  });
});

describe("the queue's groups", () => {
  it("counts the requests waiting for a decision", () => {
    const rows = ["requested", "requested", "approved", "sent"].flatMap(
      (state) => queued(state) ?? [],
    );
    expect(waitingCount(rows)).toBe(2);
    expect(waitingCount([])).toBe(0);
  });

  it.each([
    ["requested", true],
    ["approved", true],
    ["sending", true],
    ["sent", false],
    ["cancelled", false],
    ["refused", false],
  ])("treats %s as open: %s", (state, open) => {
    const row = queued(state);
    expect(row !== undefined && isOpen(row)).toBe(open);
  });
});

describe("approvalDraftOf", () => {
  const request = parsed.campaign;

  it("asks for every channel the server can send, the owner's size and the next hour in Riyadh time", () => {
    expect(approvalDraftOf(request, new Date("2026-10-27T09:20:00Z"), ["push", "sms"])).toEqual({
      push: true,
      sms: true,
      cap: "500",
      sendAt: "2026-10-27T13:00",
      note: "",
    });
  });

  it("leaves a channel the server cannot send unticked", () => {
    expect(approvalDraftOf(request, new Date("2026-10-27T09:20:00Z"), ["sms"])).toMatchObject({
      push: false,
      sms: true,
    });
    expect(approvalDraftOf(request, new Date("2026-10-27T09:20:00Z"), ["push"])).toMatchObject({
      push: true,
      sms: false,
    });
  });

  it("waits for the owner's earliest send when it is later", () => {
    const later = { ...request, sendAfter: "2026-10-30T05:30:00Z" };
    expect(approvalDraftOf(later, new Date("2026-10-27T09:20:00Z"), ["sms"]).sendAt).toBe(
      "2026-10-30T09:00",
    );
  });

  it("ignores an earliest send that has passed", () => {
    const past = { ...request, sendAfter: "2026-10-01T05:30:00Z" };
    expect(approvalDraftOf(past, new Date("2026-10-27T09:20:00Z"), ["sms"]).sendAt).toBe(
      "2026-10-27T13:00",
    );
  });
});

describe("approvalBodyOf", () => {
  const draft = { push: false, sms: true, cap: "400", sendAt: "2026-10-28T12:00", note: "" };

  it("sends the terms and the names the page showed, in UTC for Riyadh time", () => {
    expect(approvalBodyOf(draft, parsed)).toEqual({
      body: {
        channels: ["sms"],
        cap: 400,
        sendAt: "2026-10-28T09:00:00.000Z",
        expectedNameAr: "مهرجان",
        expectedNameEn: "Festival",
      },
    });
  });

  it("sends push, SMS or both as ticked, push first", () => {
    expect(approvalBodyOf({ ...draft, push: true }, parsed)).toHaveProperty("body.channels", [
      "push",
      "sms",
    ]);
    expect(approvalBodyOf({ ...draft, push: true, sms: false }, parsed)).toHaveProperty(
      "body.channels",
      ["push"],
    );
  });

  it("sends null for a name the event does not have, and a trimmed note", () => {
    const unnamed = {
      ...parsed,
      names: { ar: { name: null, issue: null }, en: parsed.names.en },
    };
    const made = approvalBodyOf({ ...draft, note: "  Agreed on the phone  " }, unnamed);
    expect(made).toMatchObject({
      body: { expectedNameAr: null, expectedNameEn: "Festival", note: "Agreed on the phone" },
    });
  });

  it.each([
    [{ sms: false }, "channels"],
    [{ push: false, sms: false }, "channels"],
    [{ cap: "49" }, "cap"],
    [{ cap: "100001" }, "cap"],
    [{ cap: "" }, "cap"],
    [{ sendAt: "" }, "sendAt"],
    [{ sendAt: "tomorrow" }, "sendAt"],
    [{ note: "x".repeat(501) }, "note"],
  ])("refuses %j with the field %s", (change, problem) => {
    expect(approvalBodyOf({ ...draft, ...change }, parsed)).toEqual({ problem });
  });

  it("accepts a note of exactly 500 characters and the cap's two ends", () => {
    expect(approvalBodyOf({ ...draft, note: "x".repeat(500) }, parsed)).toHaveProperty("body");
    expect(approvalBodyOf({ ...draft, cap: "50" }, parsed)).toHaveProperty("body.cap", 50);
    expect(approvalBodyOf({ ...draft, cap: "100000" }, parsed)).toHaveProperty("body.cap", 100_000);
  });
});

describe("approvalBlock", () => {
  it("is null when the request can be approved", () => {
    expect(approvalBlock(parsed)).toBeNull();
  });

  it("says why not, most basic reason first", () => {
    expect(blockOf({ availableChannels: [], eventIssue: "link_off" })).toBe("noChannel");
    expect(blockOf({ availableChannels: ["push"] })).toBeNull();
    expect(blockOf({ eventIssue: "link_off" })).toBe("event");
    expect(
      blockOf({ names: { ...detail.names, en: { name: "a@b.c", issue: "looks_like_address" } } }),
    ).toBe("name");
    expect(blockOf({ messages: { ar: null, en: null } })).toBe("noName");
  });
});

describe("approvalRefusalText and isRenamed", () => {
  it("words the approval's own refusals", () => {
    expect(approvalRefusalText(answerOf("channel_unavailable", { channel: "sms" }), en)).toBe(
      "SMS isn't set up on this server.",
    );
    expect(approvalRefusalText(answerOf("channel_unavailable", { channel: "push" }), en)).toBe(
      "Push notifications aren't set up on this server.",
    );
    expect(approvalRefusalText(answerOf("invalid_approval", { field: "sendAt" }), en)).toContain(
      "one hour before the event ends",
    );
    expect(approvalRefusalText(answerOf("invalid_approval", { field: "cap" }), en)).toContain("50");
  });

  it("leaves everything else to the caller", () => {
    expect(
      approvalRefusalText(answerOf("invalid_approval", { field: "other" }), en),
    ).toBeUndefined();
    expect(approvalRefusalText(answerOf("wrong_state"), en)).toBeUndefined();
    expect(approvalRefusalText(undefined, en)).toBeUndefined();
  });

  it("knows the rename conflict", () => {
    expect(isRenamed(answerOf("event_renamed"))).toBe(true);
    expect(isRenamed(answerOf("wrong_state"))).toBe(false);
    expect(isRenamed(undefined)).toBe(false);
  });
});
