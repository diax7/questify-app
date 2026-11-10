import type { MessageKey } from "@questify/shared";
import { CAPABILITIES, type PlatformName } from "#src/platform/capabilities.ts";

/** What a quest needs of the platform to be played, by the way it is verified. `null` needs nothing (it is shown or typed). */
const METHOD_NEEDS: ReadonlyMap<string, "cameraQr" | "nfc" | null> = new Map([
  ["quest_qr", "cameraQr"],
  ["screen_qr", "cameraQr"],
  ["nfc", "nfc"],
  ["my_qr", null],
  ["kiosk", null],
]);

export type QuestAvailability =
  | Readonly<{ kind: "available" }>
  | Readonly<{ kind: "needs_app"; text: MessageKey; hint: MessageKey }>;

const AVAILABLE: QuestAvailability = { kind: "available" };

/**
 * Whether a quest can be played on this platform (T-803). A quest that can only be verified with something the platform
 * lacks (on the web: a tag that needs NFC) says it needs the phone app, in both languages. One method the platform
 * offers is enough: a quest with a QR code and an NFC tag plays by the QR on the web. A method this app does not know
 * counts as nothing needed, as does a quest with no verification (a quiz, a vote, a code to type, a location check: the
 * browser reads the position itself), so the server's answer stays the judge.
 */
export function questAvailability(
  platform: PlatformName,
  quest: Readonly<{ verification: readonly string[] }>,
): QuestAvailability {
  const offered = CAPABILITIES[platform];
  const needs = quest.verification.map((method) => METHOD_NEEDS.get(method) ?? null);
  if (needs.length === 0 || needs.some((need) => need === null || offered[need])) {
    return AVAILABLE;
  }
  return { kind: "needs_app", text: "quests.needsApp", hint: "quests.needsAppHint" };
}
