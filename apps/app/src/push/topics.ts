import type { MessageKey, PushTopic, PushTopics } from "@questify/shared";

/** The four mutable topics as Settings words them (FR-1115): a name and a line saying what it carries. */
export const TOPIC_TEXT = {
  announcements: { title: "pushTopic.announcements", about: "pushTopic.announcements.about" },
  rank: { title: "pushTopic.rank", about: "pushTopic.rank.about" },
  community: { title: "pushTopic.community", about: "pushTopic.community.about" },
  reminders: { title: "pushTopic.reminders", about: "pushTopic.reminders.about" },
} as const satisfies Record<PushTopic, { title: MessageKey; about: MessageKey }>;

/** The topics with one changed, shown at once while the save is on its way. */
export const withTopic = (topics: PushTopics, topic: PushTopic, on: boolean): PushTopics => ({
  ...topics,
  [topic]: on,
});
