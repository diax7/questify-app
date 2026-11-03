import {
  PLAYER_INTRO_KEYS,
  playerIntroAdminSchema,
  readPlayerIntro,
  type PlayerIntro,
} from "@questify/shared";

/** The console's editor of the player intro's cards (T-802b, FR-1803): one document, read and saved at one address. */
export const PLAYER_INTRO_API = "/v1/admin/catalog/player-intro";

/** The intro in force and whether an earlier state can be put back. */
export type PlayerIntroRow = Readonly<{ intro: PlayerIntro; revertible: boolean }>;

/**
 * The intro the API listed, repaired (`readPlayerIntro` drops a name that is not a card and lets a missing card join the
 * end), or undefined when the body is not the expected shape, so a changed API shows the error state.
 */
export function readPlayerIntroRow(body: unknown): PlayerIntroRow | undefined {
  const parsed = playerIntroAdminSchema.safeParse(body);
  return parsed.success
    ? { intro: readPlayerIntro(parsed.data), revertible: parsed.data.revertible }
    : undefined;
}

/** Whether the draft hides every card, which the server refuses: at least one card stays shown. */
export const hidesEveryCard = (draft: PlayerIntro): boolean =>
  PLAYER_INTRO_KEYS.every((key) => draft.hidden.includes(key));
