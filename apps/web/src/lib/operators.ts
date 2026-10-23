import type { MessageKey } from "@questify/shared";

/** FR-908: the abilities in the API's order (apps/api/src/operators/operators.ts). */
export const ABILITIES = [
  "scan_quests",
  "award",
  "hand_over",
  "review",
  "help_desk",
  "write_nfc",
  "show_rotating_qr",
] as const;
export type Ability = (typeof ABILITIES)[number];

/** FR-1720: the presets an invite carries. */
export const PRESETS = ["full", "scanner", "prize_desk", "moderator"] as const;
export type Preset = (typeof PRESETS)[number];

export type InviteKind = "personal" | "batch" | "email";

/** An operator as the API lists it. */
export type OperatorView = Readonly<{
  id: string;
  playerId: string;
  username: string;
  avatar: string;
  abilities: readonly string[];
  canPlay: boolean;
  questIds: readonly string[];
  claimedVia: Readonly<{ inviteId: string; label: string }> | null;
}>;

/** An invite as the API lists it; `url` only for the owner, only while a personal invite is open. */
export type InviteView = Readonly<{
  id: string;
  kind: "personal" | "email";
  label: string;
  email: string | null;
  abilities: readonly string[];
  status: "open" | "claimed" | "revoked" | "expired";
  /** `username` is null for an account deleted since (T-217). */
  claimedBy: Readonly<{ username: string | null }> | null;
  url?: string;
}>;

/** A snake_case API value as the camelCase segment message keys use (`scan_quests` → `scanQuests`). */
export function keySegment(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export const abilityKey = (ability: string): MessageKey =>
  `operators.ability.${keySegment(ability)}` as MessageKey;

export const presetKey = (preset: Preset): MessageKey =>
  `operators.preset.${keySegment(preset)}` as MessageKey;

/** The body that creates invites of a kind; the fields the kind does not use are left out. */
export function inviteBody(
  draft: Readonly<{
    kind: InviteKind;
    label: string;
    count: number;
    email: string;
    preset: Preset;
  }>,
  language: "ar" | "en",
): Record<string, unknown> {
  switch (draft.kind) {
    case "personal":
      return { kind: "personal", label: draft.label.trim(), preset: draft.preset };
    case "batch":
      return { kind: "batch", label: draft.label.trim(), count: draft.count, preset: draft.preset };
    case "email":
      return { kind: "email", email: draft.email.trim(), preset: draft.preset, lang: language };
  }
}

/** The invites that print: the open personal ones the owner was given an address for. */
export function printable(invites: readonly InviteView[]): Array<InviteView & { url: string }> {
  return invites.filter(
    (invite): invite is InviteView & { url: string } =>
      invite.status === "open" && invite.url !== undefined,
  );
}

/** An operator's abilities with one turned on or off, kept in the API's order. */
export function withAbility(
  abilities: readonly string[],
  ability: Ability,
  on: boolean,
): Ability[] {
  return ABILITIES.filter((item) => (item === ability ? on : abilities.includes(item)));
}
