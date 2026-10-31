import { MESSAGES, PUSH_TOPICS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { CHANNELS, channelNames } from "#src/push/channels.ts";
import { TOPIC_TEXT, withTopic } from "#src/push/topics.ts";

describe("the Android channels", () => {
  it("are the four topics, personal and offers: the names the server gives a push", () => {
    expect(CHANNELS.map((channel) => channel.id).sort()).toEqual(
      [...PUSH_TOPICS, "personal", "offers"].sort(),
    );
  });

  it("hide the text on a locked screen for personal messages and offers only", () => {
    const hidden = CHANNELS.filter((channel) => channel.lockscreen === "private").map((c) => c.id);
    expect(hidden.sort()).toEqual(["offers", "personal"]);
  });

  it("are named in both languages with the app's own words", () => {
    for (const language of ["ar", "en"] as const) {
      const names = channelNames((key) => MESSAGES[key][language]);
      for (const channel of CHANNELS) expect(names[channel.id], channel.id).not.toBe("");
      expect(new Set(Object.values(names)).size).toBe(CHANNELS.length);
    }
  });
});

describe("the topic switches", () => {
  it("have a name and a line in both languages for every topic", () => {
    for (const topic of PUSH_TOPICS) {
      for (const key of [TOPIC_TEXT[topic].title, TOPIC_TEXT[topic].about]) {
        expect(MESSAGES[key].ar, key).not.toBe("");
        expect(MESSAGES[key].en, key).not.toBe("");
      }
    }
  });

  it("change one topic and keep the others", () => {
    const topics = {
      announcements: true,
      rank: true,
      community: true,
      reminders: true,
      eventOff: [],
    };
    expect(withTopic(topics, "rank", false)).toEqual({ ...topics, rank: false });
    expect(topics.rank).toBe(true);
  });

  it("stop waiting on an event's default once the player sets the topic", () => {
    const topics = {
      announcements: true,
      rank: false,
      community: false,
      reminders: true,
      eventOff: ["rank", "community"] as const,
    };
    expect(withTopic({ ...topics, eventOff: [...topics.eventOff] }, "rank", true)).toEqual({
      ...topics,
      rank: true,
      eventOff: ["community"],
    });
  });
});
