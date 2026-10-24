import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  CARD_TITLES,
  CENTER_CARDS,
  EVENT_CHOICES,
  cardNeedsEvent,
  initialOf,
  kindLabel,
  replyFromKey,
  sendLine,
  sendPlatformTicket,
  usernameOf,
} from "#src/help/center.ts";
import { deviceFactsOf, deviceLine, readModelName } from "#src/help/device.ts";

const ok = (body: unknown) => ({ kind: "ok" as const, status: 201, body, headers: new Headers() });

const recording = () => {
  const sent: unknown[] = [];
  return {
    sent,
    session: {
      request: async (request: unknown) => {
        sent.push(request);
        return ok({ ticket: { id: "1" } });
      },
    },
  };
};

describe("the ticket center's cards (T-312)", () => {
  it("has four cards, two to the event team and two to Questify, each with a title", () => {
    expect(CENTER_CARDS).toEqual(["report", "event", "app", "suggestion"]);
    expect(CENTER_CARDS.filter(cardNeedsEvent)).toEqual(["report", "event"]);
    for (const card of CENTER_CARDS) {
      expect(CARD_TITLES[card] in MESSAGES).toBe(true);
    }
    expect(EVENT_CHOICES.map((choice) => choice.kind)).toEqual(["question", "prize", "problem"]);
  });

  it("opens the card a link names, or the event card for a kind; nothing otherwise", () => {
    expect(initialOf({})).toBeUndefined();
    expect(initialOf({ kind: "bogus" })).toBeUndefined();
    expect(initialOf({ card: "report", questId: "q" })).toEqual({
      card: "report",
      kind: null,
      questId: null,
      questTitle: null,
    });
    expect(initialOf({ kind: "problem", questId: "q", questTitle: "Find" })).toEqual({
      card: "event",
      kind: "problem",
      questId: "q",
      questTitle: "Find",
    });
    expect(initialOf({ kind: "prize" })).toMatchObject({ card: "event", kind: "prize" });
    expect(initialOf({ card: "app", kind: "prize" })).toMatchObject({ card: "app", kind: null });
  });

  it("says each answer in words, by where the request went", () => {
    expect(sendLine({ kind: "sent" }, false)).toBe("help.sent");
    expect(sendLine({ kind: "sent" }, true)).toBe("help.sentQuestify");
    expect(sendLine({ kind: "too_many_open" }, true)).toBe("help.tooManyPlatform");
    expect(sendLine({ kind: "too_many_open" }, false)).toBe("help.tooManyOpen");
    expect(sendLine({ kind: "unknown_player" }, false)).toBe("help.report.unknown");
    expect(sendLine({ kind: "self_report" }, false)).toBe("help.report.self");
    expect(sendLine({ kind: "already_reported" }, false)).toBe("help.report.already");
    expect(sendLine({ kind: "too_many_lookups" }, false)).toBe("help.report.tooManyLookups");
    expect(sendLine({ kind: "refused", message: null }, false)).toBeNull();
    expect(sendLine({ kind: "signed_out" }, false)).toBeNull();
  });

  it("reads a typed username without its @, and signs a reply by team, never a person", () => {
    expect(usernameOf("  @Sara_K ")).toBe("Sara_K");
    expect(replyFromKey({ answeredBy: "questify" })).toBe("help.replyFromQuestify");
    expect(replyFromKey({ answeredBy: "event" })).toBe("help.replyFrom");
    expect(replyFromKey({ answeredBy: null })).toBe("help.replyFrom");
    for (const kind of [
      "question",
      "problem",
      "prize",
      "report_player",
      "app_problem",
      "suggestion",
    ] as const) {
      expect(kindLabel(kind) in MESSAGES, kind).toBe(true);
    }
  });

  it("sends an app problem with the device and a suggestion with none, with the key", async () => {
    const { sent, session } = recording();
    const device = {
      appVersion: "1.4.0",
      platform: "ios",
      osVersion: "18.1",
      model: null,
    } as const;
    expect(
      await sendPlatformTicket(session, { kind: "app_problem", text: "Blank", device, key: "k" }),
    ).toEqual({
      kind: "sent",
    });
    await sendPlatformTicket(session, { kind: "suggestion", text: "Idea", device, key: "s" });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/me/tickets",
        body: { kind: "app_problem", text: "Blank", device },
        headers: { "idempotency-key": "k" },
      },
      {
        method: "POST",
        path: "/v1/me/tickets",
        body: { kind: "suggestion", text: "Idea" },
        headers: { "idempotency-key": "s" },
      },
    ]);
  });
});

describe("the device facts (ADR-259)", () => {
  const base = {
    appVersion: "1.4.0",
    os: "ios",
    osVersion: "18.1",
    modelName: "iPhone 15 Pro",
    androidModel: undefined,
  };

  it("sends the version, the platform, the OS and the model, and says them in one line", () => {
    const facts = deviceFactsOf(base);
    expect(facts).toEqual({
      appVersion: "1.4.0",
      platform: "ios",
      osVersion: "18.1",
      model: "iPhone 15 Pro",
    });
    expect(deviceLine(facts ?? (undefined as never))).toBe(
      "Questify 1.4.0, iPhone 15 Pro, iOS 18.1",
    );
    expect(
      deviceLine({ appVersion: "1.4.0", platform: "android", osVersion: "34", model: null }),
    ).toBe("Questify 1.4.0, Android 34");
  });

  it("falls back to Android's own model, and sends no model at all without one", () => {
    expect(
      deviceFactsOf({
        ...base,
        os: "android",
        osVersion: 34,
        modelName: undefined,
        androidModel: "Pixel 8",
      }),
    ).toMatchObject({
      platform: "android",
      osVersion: "34",
      model: "Pixel 8",
    });
    expect(deviceFactsOf({ ...base, modelName: undefined })?.model).toBeNull();
    expect(deviceFactsOf({ ...base, modelName: "  ‮iPhone\u0007 " })?.model).toBe("iPhone");
    expect(deviceFactsOf({ ...base, modelName: "x".repeat(80) })?.model).toHaveLength(64);
  });

  it("gives no facts when the version, the OS or the platform cannot be read", () => {
    expect(deviceFactsOf({ ...base, appVersion: undefined })).toBeNull();
    expect(deviceFactsOf({ ...base, appVersion: "1.4 beta" })).toBeNull();
    expect(deviceFactsOf({ ...base, osVersion: null })).toBeNull();
    expect(deviceFactsOf({ ...base, os: "web" })).toBeNull();
  });

  it("reads the model from expo-device when the build has it, and nothing when its load throws", async () => {
    expect(await readModelName(async () => ({ modelName: "iPhone 15 Pro" }))).toBe("iPhone 15 Pro");
    expect(
      await readModelName(async () => {
        throw new Error("Cannot find native module 'ExpoDevice'");
      }),
    ).toBeUndefined();
  });

  it("loads expo-device only lazily, and never reads the phone's own name", () => {
    const root = join(__dirname, "..", "..");
    const files = ["app", "src"].flatMap((folder) =>
      readdirSync(join(root, folder), { withFileTypes: true, recursive: true })
        .filter(
          (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."),
        )
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")),
    );
    expect(files.filter((source) => /deviceName/.test(source))).toEqual([]);
    expect(
      files.filter((source) => /from "expo-device"|require\("expo-device"\)/.test(source)),
    ).toEqual([]);
    expect(files.filter((source) => source.includes('import("expo-device")'))).toHaveLength(1);
  });
});
