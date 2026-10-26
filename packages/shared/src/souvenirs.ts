import { z } from "zod";
import { itemSchema } from "./players/items";

// Names show publicly in other events' profiles and rankings: control, line-separator and bidi embedding, override or
// isolate characters would reorder or break the line around them (as event terms and submissions refuse them).
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => !FORBIDDEN.test(value), "must hold no control or direction characters");
export const souvenirBodySchema = z
  .strictObject({
    kind: z.enum(["frame", "title", "character"]),
    name: z.strictObject({ ar: name, en: name }),
    visualKey: z.string().nullable(),
    audience: z.enum(["joined", "category", "all", "rank"]),
    categoryId: z.uuid().nullable().default(null),
    rankFrom: z.number().int().min(1).max(100).nullable().default(null),
    rankTo: z.number().int().min(1).max(100).nullable().default(null),
  })
  .superRefine((body, context) => {
    const issue = (path: string) => context.addIssue({ code: "custom", path: [path] });
    if ((body.audience === "category") !== (body.categoryId !== null)) issue("categoryId");
    if (body.audience === "rank") {
      if (body.rankFrom === null || body.rankTo === null || body.rankFrom > body.rankTo)
        issue("rankTo");
    } else if (body.rankFrom !== null || body.rankTo !== null) issue("rankFrom");
    const visual = body.visualKey;
    if (
      (body.kind === "title" && visual !== null) ||
      (body.kind === "character" && visual !== "chest") ||
      (body.kind === "frame" && (visual === null || !/^frame-(0[1-9]|1[0-4])$/.test(visual)))
    )
      issue("visualKey");
  });
export type SouvenirBody = z.infer<typeof souvenirBodySchema>;
export const souvenirRuleSchema = z.object({
  id: z.uuid(),
  item: itemSchema,
  audience: z.enum(["joined", "category", "all", "rank"]),
  categoryId: z.uuid().nullable(),
  rankFrom: z.number().nullable(),
  rankTo: z.number().nullable(),
  status: z.enum(["draft", "active", "stopped"]),
  targetCount: z.number().int().nonnegative(),
  targetIds: z.array(z.uuid()),
  granted: z.number().int().nonnegative(),
  waitingForResults: z.boolean(),
});
export type SouvenirRule = z.infer<typeof souvenirRuleSchema>;
export const souvenirListSchema = z.object({
  rules: z.array(souvenirRuleSchema),
  archived: z.boolean(),
  due: z.number().int().nonnegative(),
  scanning: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type SouvenirList = z.infer<typeof souvenirListSchema>;
