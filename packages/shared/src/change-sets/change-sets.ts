import { z } from "zod";

/** The states an item shows on the review page: the API's check now, or what happened to it. */
export const CHANGE_SET_ITEM_STATES = ["ready", "invalid", "stale", "applied", "failed"] as const;
export type ChangeSetItemState = (typeof CHANGE_SET_ITEM_STATES)[number];

const text = z.object({ ar: z.string().nullable(), en: z.string().nullable() });
const problem = z.object({
  code: z.string(),
  message: z.object({ ar: z.string(), en: z.string() }),
  details: z.record(z.string(), z.unknown()),
});
const values = z.record(z.string(), z.unknown());

/** One item of a change set as the review page shows it (`GET …/change-sets/{id}`). */
export const changeSetItemSchema = z.object({
  id: z.uuid(),
  op: z.enum(["add", "edit", "delete"]),
  target: z.enum(["quest", "category", "reward"]),
  name: text.nullable(),
  state: z.enum(CHANGE_SET_ITEM_STATES),
  /** The fields that differ, in the change log's own words: before and after. */
  diff: z.object({ before: values, after: values }).nullable(),
  /** The points and quest choices the item carries (`apply`, `points`, `quests`). */
  choices: z.record(z.string(), z.string()),
  problem: problem.nullable(),
});
export type ChangeSetItem = z.infer<typeof changeSetItemSchema>;

const set = z.object({
  id: z.uuid(),
  status: z.enum(["open", "applied", "closed"]),
  createdAt: z.string(),
});

export const changeSetSummarySchema = set.extend({
  items: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type ChangeSetSummary = z.infer<typeof changeSetSummarySchema>;

export const changeSetListSchema = z.object({ changeSets: changeSetSummarySchema.array() });

export const changeSetSchema = set.extend({ items: changeSetItemSchema.array() });
export type ChangeSetView = z.infer<typeof changeSetSchema>;
export const changeSetReadSchema = z.object({ changeSet: changeSetSchema });

/** The answer of an apply: what happened to each selected item, and the set's status after. */
export const changeSetAppliedSchema = z.object({
  changeSet: z.object({ id: z.uuid(), status: z.enum(["open", "applied", "closed"]) }),
  results: z
    .object({
      itemId: z.uuid(),
      status: z.enum(["applied", "failed", "stale"]),
      error: problem.nullable(),
    })
    .array(),
});
export type ChangeSetApplied = z.infer<typeof changeSetAppliedSchema>;
