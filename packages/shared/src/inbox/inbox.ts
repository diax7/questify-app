import { z } from "zod";

/**
 * `GET …/events/{id}/inbox` (T-616, FR-1825): what waits for the event's team, counts only. No player, name or text
 * leaves in it; the page lists the requests through the Help desk's and the join queue's own reads.
 */

const count = z.number().int().min(0);

export const inboxSchema = z.strictObject({
  /** Open help requests of the event's queue by kind: the Help desk's Open tab, filtered by the same kind. */
  tickets: z.strictObject({
    question: count,
    problem: count,
    prize: count,
    report_player: count,
  }),
  /** Open requests the team escalated and Questify has not answered yet. */
  withQuestify: count,
  /** Pending requests and the waiting list; `private` says the event takes join requests. */
  joinRequests: z.strictObject({ pending: count, private: z.boolean() }),
  /** Submissions waiting for review. */
  submissions: count,
  /** Open flagged-activity cases. */
  flags: count,
});

export type Inbox = z.infer<typeof inboxSchema>;
