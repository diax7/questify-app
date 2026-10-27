import { MESSAGES, type PushTexts } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  apnsRequest,
  fcmRequest,
  pushMessageOf,
  refIds,
  secondsLeft,
  type ClaimedSend,
} from "#src/push/message";

const EVENT_ID = "5f0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e";
const QUEST_ID = "9a0f2b0e-8c3e-4d7c-9a51-2a2f0b1c3d4e";

const TEXTS: PushTexts = {
  messages: {
    ...MESSAGES,
    "push.t.body": { ar: "{questOne} بوقت محدود: {quest}", en: "Flash {questOne}: {quest}" },
    "push.t.nameless": { ar: "{questOne} بوقت محدود الآن", en: "A flash {questOne} is on now" },
  },
  templates: { test_flash: { body: "push.t.body", nameless: "push.t.nameless" } },
};

const claim = (over: Partial<ClaimedSend> = {}): ClaimedSend => ({
  send_id: "7",
  lease: "c1f0f2b0-8c3e-4d7c-9a51-2a2f0b1c3d4e",
  lease_until: new Date("2026-10-28T10:01:00Z"),
  target: "apns:production",
  token: "a".repeat(64),
  language: "en",
  kind: "test_flash",
  class: "event",
  topic: "announcements",
  notification_id: "42",
  event_id: EVENT_ID,
  refs: { quest: QUEST_ID },
  params: { event: { ar: "مهرجان الشتاء", en: "Winter Fest" }, quest: { en: "Find the falcon" } },
  expires_at: new Date("2026-10-28T12:00:00Z"),
  priority: 1,
  attempts: 0,
  terms: null,
  timezone: "Asia/Riyadh",
  ...over,
});

describe("pushMessageOf (ADR-346)", () => {
  it("renders the kind's template in the device's language with ids only in the data", () => {
    expect(pushMessageOf(claim(), TEXTS)).toEqual({
      token: "a".repeat(64),
      collapseId: "n42",
      priority: "high",
      expiresAt: new Date("2026-10-28T12:00:00Z"),
      title: "Winter Fest",
      body: "Flash quest: Find the falcon",
      channel: "announcements",
      threadId: EVENT_ID,
      data: { n: "42", k: "test_flash", e: EVENT_ID, r: JSON.stringify({ quest: QUEST_ID }) },
    });
    expect(pushMessageOf(claim({ language: "ar" }), TEXTS)?.title).toBe("مهرجان الشتاء");
  });

  it("is null for a kind without a template: never pushed", () => {
    expect(pushMessageOf(claim({ kind: "no_template_kind" }), TEXTS)).toBeNull();
    expect(pushMessageOf(claim())).toBeNull();
  });

  it("sends promotions at normal priority on the offers channel, personal ones on personal, without an event on questify", () => {
    const promo = pushMessageOf(claim({ class: "promo", topic: null, kind: "test_flash" }), TEXTS);
    expect(promo).toMatchObject({ priority: "normal", channel: "offers" });
    const personal = pushMessageOf(
      claim({ class: "personal", topic: null, event_id: null }),
      TEXTS,
    );
    expect(personal).toMatchObject({ priority: "high", channel: "personal", threadId: "questify" });
    expect(personal?.data["e"]).toBe("");
  });

  it("keeps only id references: no names, no text, no nested values", () => {
    expect(
      refIds({
        quest: QUEST_ID,
        place: 3,
        name: "Find the falcon",
        nested: { id: QUEST_ID },
        "bad key": QUEST_ID,
        huge: "1".repeat(19),
      }),
    ).toEqual({ quest: QUEST_ID, place: "3" });
    expect(refIds(null)).toEqual({});
    expect(refIds([QUEST_ID])).toEqual({});
  });
});

const longest = (script: "ar" | "en") => (script === "ar" ? "ص".repeat(60) : "W".repeat(60));

describe("the provider requests", () => {
  it("stays under 4 KB with the longest names in both scripts", () => {
    for (const language of ["ar", "en"] as const) {
      const message = pushMessageOf(
        claim({
          language,
          params: {
            event: { ar: longest("ar"), en: longest("en") },
            quest: { ar: longest("ar"), en: longest("en") },
          },
          refs: { quest: QUEST_ID, category: EVENT_ID, reward: QUEST_ID },
        }),
        TEXTS,
      );
      expect(message).not.toBeNull();
      if (message === null) return;
      expect(Buffer.byteLength(apnsRequest(message, "sa.nafes.questify").body)).toBeLessThan(4096);
      expect(Buffer.byteLength(fcmRequest(message, new Date("2026-10-28T10:00:00Z")))).toBeLessThan(
        4096,
      );
      expect(message.title.length).toBeLessThanOrEqual(43);
    }
  });

  it("gives APNs the push type, topic, priority, expiry and collapse id; the ids under q", () => {
    const message = pushMessageOf(claim(), TEXTS);
    if (message === null) throw new Error("expected a message");
    const request = apnsRequest(message, "sa.nafes.questify");
    expect(request.headers).toEqual({
      "apns-push-type": "alert",
      "apns-topic": "sa.nafes.questify",
      "apns-priority": "10",
      "apns-expiration": String(Date.parse("2026-10-28T12:00:00Z") / 1000),
      "apns-collapse-id": "n42",
    });
    expect(JSON.parse(request.body)).toEqual({
      aps: {
        alert: { title: "Winter Fest", body: "Flash quest: Find the falcon" },
        sound: "default",
        "thread-id": EVENT_ID,
      },
      q: message.data,
    });
    expect(apnsRequest({ ...message, priority: "normal" }, "t").headers["apns-priority"]).toBe("5");
  });

  it("gives FCM the notification, the ids as data, the priority, the time left and the tag on the channel", () => {
    const message = pushMessageOf(claim(), TEXTS);
    if (message === null) throw new Error("expected a message");
    const now = new Date("2026-10-28T11:00:00.500Z");
    expect(JSON.parse(fcmRequest(message, now))).toEqual({
      message: {
        token: "a".repeat(64),
        notification: { title: "Winter Fest", body: "Flash quest: Find the falcon" },
        data: message.data,
        android: {
          priority: "HIGH",
          ttl: "3600s",
          notification: { tag: "n42", channel_id: "announcements" },
        },
      },
    });
    expect(
      JSON.parse(fcmRequest({ ...message, priority: "normal" }, now)).message.android.priority,
    ).toBe("NORMAL");
    expect(secondsLeft(message, new Date("2026-10-29T00:00:00Z"))).toBe(0);
  });
});
