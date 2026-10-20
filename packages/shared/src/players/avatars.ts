/** Questify's six default avatars (FR-117): shipped art, so a fixed list, not configuration. 0016's CHECK holds the same. */
export const AVATARS = ["falcon", "fox", "camel", "owl", "lantern", "explorer-hat"] as const;

export type Avatar = (typeof AVATARS)[number];
