import { PUSH_TOPICS, type MessageKey, type PushTopic } from "@questify/shared";

/**
 * The Android notification channels (FR-1115, ADR-349 (5)). The server names the channel of each push: the kind's topic,
 * else `personal`, and `offers` for a promotion (`pushMessageOf`). A push for a channel the phone lacks falls back to
 * Android's own default, so all six are created before the permission prompt and the token.
 */
export type ChannelId = PushTopic | "personal" | "offers";

export type ChannelSpec = Readonly<{
  id: ChannelId;
  /** The channel's name in Android's settings, a message key rendered in the app's language. */
  name: MessageKey;
  importance: "high" | "default";
  /** `private`: the lock screen shows that a notification arrived, not its text (personal and offers). */
  lockscreen: "private" | "public";
}>;

const TOPIC_NAME = {
  announcements: "pushTopic.announcements",
  rank: "pushTopic.rank",
  community: "pushTopic.community",
  reminders: "pushTopic.reminders",
} as const satisfies Record<PushTopic, MessageKey>;

const TOPIC_IMPORTANCE = {
  announcements: "high",
  rank: "default",
  community: "default",
  reminders: "default",
} as const satisfies Record<PushTopic, ChannelSpec["importance"]>;

export const CHANNELS: readonly ChannelSpec[] = [
  { id: "personal", name: "push.channel.personal", importance: "high", lockscreen: "private" },
  ...PUSH_TOPICS.map((topic): ChannelSpec => ({
    id: topic,
    name: TOPIC_NAME[topic],
    importance: TOPIC_IMPORTANCE[topic],
    lockscreen: "public",
  })),
  { id: "offers", name: "push.channel.offers", importance: "default", lockscreen: "private" },
];

/** The channels' names in one language, by id. */
export type ChannelNames = Readonly<Record<ChannelId, string>>;

/** Renders every channel's name with the app's translator. */
export function channelNames(translate: (key: MessageKey) => string): ChannelNames {
  const names = {} as Record<ChannelId, string>;
  for (const channel of CHANNELS) names[channel.id] = translate(channel.name);
  return names;
}
