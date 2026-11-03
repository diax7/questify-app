import {
  checkQuestifyHome,
  homeLayoutAdminSchema,
  readQuestifyHome,
  type MessageKey,
  type QuestifyHome,
} from "@questify/shared";
import { problemOf } from "#src/lib/home-content-editor.ts";

/** The console's editor of Questify home (T-713, FR-1838): one document, read and saved at one address. */
export const HOME_LAYOUT_API = "/v1/admin/catalog/home-layout";

/** The layout in force and whether an earlier state can be put back. */
export type HomeLayoutRow = Readonly<{ layout: QuestifyHome; revertible: boolean }>;

/**
 * The layout the API listed, repaired (`readQuestifyHome` drops a name that is not a block and lets a missing block join the
 * end), or undefined when the body is not the expected shape, so a changed API shows the error state.
 */
export function readHomeLayout(body: unknown): HomeLayoutRow | undefined {
  const parsed = homeLayoutAdminSchema.safeParse(body);
  return parsed.success
    ? { layout: readQuestifyHome(parsed.data), revertible: parsed.data.revertible }
    : undefined;
}

/**
 * What is wrong with the draft, in the admin's words: the first problem the shared check finds (a slide with no title, a
 * link that is not https), or null when it can be saved. Reordering and showing cannot go wrong, so only the slides speak.
 */
export function homeProblem(draft: QuestifyHome): Readonly<{ key: MessageKey; n: number }> | null {
  const checked = checkQuestifyHome(draft);
  const issue = checked.ok ? undefined : checked.issues[0];
  return issue === undefined ? null : problemOf(`content.${issue.path}`);
}
