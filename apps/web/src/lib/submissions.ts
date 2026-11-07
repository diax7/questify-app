import type { MessageKey } from "@questify/shared";

export type QueueFilter = "pending" | "unseen" | "marked" | "done";

/** The queue's tabs, in order: what waits first. */
export const FILTERS: readonly QueueFilter[] = ["pending", "unseen", "marked", "done"];

export type SubmissionStatus = "pending" | "approved" | "rejected" | "removed";

/** One item of `GET …/events/{id}/submissions` (T-301). */
export type QueueItem = Readonly<{
  id: string;
  questId: string;
  questTitle: Readonly<{ ar: string | null; en: string | null }>;
  enrollmentId: string;
  /** Null for a deleted account. */
  username: string | null;
  avatar: string;
  /** Null once the account is deleted. */
  text: string | null;
  points: number;
  status: SubmissionStatus;
  auto: boolean;
  marked: boolean;
  reason: string | null;
  reasonSystem: boolean;
  createdAt: string;
  reviewedAt: string | null;
  seenAt: string | null;
}>;

const STATUS_KEYS: Readonly<Record<SubmissionStatus, MessageKey>> = {
  pending: "submissions.status.pending",
  approved: "submissions.status.approved",
  rejected: "submissions.status.rejected",
  removed: "submissions.status.removed",
};

export const statusKey = (status: SubmissionStatus): MessageKey => STATUS_KEYS[status];

/** "Nothing here": the list is read and empty, and no read mark is still waiting for the server (the rows are only hidden). */
export const showsEmpty = (items: readonly QueueItem[] | null, marking: boolean): boolean =>
  items?.length === 0 && !marking;

/** The "Mark these as read" button: on the unseen tab while there are rows, and while a mark is waiting for the server. */
export const showsMarkSeen = (
  filter: QueueFilter,
  items: readonly QueueItem[] | null,
  marking: boolean,
): boolean => filter === "unseen" && ((items?.length ?? 0) > 0 || marking);

/** The queue without the items named: what the "unseen" tab shows at once while the server is told they were read. */
export const withoutItems = (items: readonly QueueItem[], ids: readonly string[]): QueueItem[] =>
  items.filter((item) => !ids.includes(item.id));

/** A rejection or a removal needs a reason of 1 to 300 characters (the player sees it). */
export const canGiveReason = (reason: string): boolean => {
  const length = reason.trim().length;
  return length >= 1 && length <= 300;
};
