import { parseVerification, type QuestType, type QuestVerification } from "@questify/shared";
import type { QuestDraft } from "#src/lib/quests.ts";

const PRINTED: ReadonlySet<QuestVerification> = new Set(["quest_qr", "nfc"]);

/** Whether ticking `method` must untick `item`: the screen QR against a printed code or its NFC tag (ADR-240). */
export const clashes = (method: QuestVerification, item: QuestVerification): boolean =>
  (method === "screen_qr" && PRINTED.has(item)) || (PRINTED.has(method) && item === "screen_qr");

/**
 * The methods left ticked after `method` is ticked or unticked. NFC keeps the quest QR on as its backup (FR-313):
 * ticking it ticks the QR. The screen QR never sits beside a printed code (ADR-240): ticking one side unticks the other.
 */
export function toggledVerification(
  offered: readonly QuestVerification[],
  current: readonly QuestVerification[],
  method: QuestVerification,
  on: boolean,
): QuestVerification[] {
  return offered.filter((item) => {
    if (item === method) {
      return on;
    }
    if (on && clashes(method, item)) {
      return false;
    }
    return current.includes(item) || (method === "nfc" && on && item === "quest_qr");
  });
}

/** The types the Type field lists: a location quest only while the platform switch is on, or when the quest is one. */
export const listedTypes = (
  names: readonly QuestType[],
  locationQuestsOn: boolean,
  current: QuestType,
): QuestType[] =>
  names.filter((type) => type !== "location" || locationQuestsOn || current === "location");

/**
 * What changing the type resets: its starting config and verification, and a meet quest starts able to pay its
 * default daily cap (ADR-210).
 */
export function typeChangePatch(
  type: QuestType,
  config: QuestDraft["config"],
): Partial<QuestDraft> {
  return {
    type,
    config,
    ...(type === "meet" ? { repeatCap: 10 } : {}),
    verification: parseVerification(type, undefined) ?? [],
  };
}

/** What ticking Flash changes: on a quest with no times it also hides the quest, to be launched from the list. */
export function flashPatch(
  checked: boolean,
  draft: Pick<QuestDraft, "opensAt" | "closesAt">,
): Partial<QuestDraft> {
  return {
    flash: checked,
    ...(checked && (draft.opensAt === "" || draft.closesAt === "") ? { visible: false } : {}),
  };
}

/** A number box's text as a number; nothing while it is empty (the box keeps its last number). */
export const typedNumber = (text: string): number | undefined =>
  text === "" ? undefined : Number(text);
