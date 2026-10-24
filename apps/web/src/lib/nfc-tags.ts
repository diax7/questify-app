import type { CategoryView } from "#src/lib/quests.ts";

/** A tag on a quest's Tags panel (`GET …/quests/{id}/nfc-tags`, T-308). */
export type TagLine = Readonly<{
  id: string;
  label: string;
  locked: boolean;
  status: "active" | "revoked";
  writtenAt: string;
  writtenBy: string | null;
  taps: number;
  /** Taps whose sticker id was not the registered one: the tag may have been copied. */
  copies: number;
  /** Taps the phone could not check (an iPhone that could not read the sticker's id). */
  unchecked: number;
  lastTapAt: string | null;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTag = (value: unknown): value is TagLine =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["label"] === "string" &&
  typeof value["locked"] === "boolean" &&
  (value["status"] === "active" || value["status"] === "revoked") &&
  typeof value["writtenAt"] === "string" &&
  (value["writtenBy"] === null || typeof value["writtenBy"] === "string") &&
  typeof value["taps"] === "number" &&
  typeof value["copies"] === "number" &&
  typeof value["unchecked"] === "number" &&
  (value["lastTapAt"] === null || typeof value["lastTapAt"] === "string");

/** The tags in the list's answer, or undefined when it is not that shape. */
export function tagsOf(body: unknown): readonly TagLine[] | undefined {
  const list = isRecord(body) ? body["tags"] : undefined;
  return Array.isArray(list) && list.every(isTag) ? list : undefined;
}

/** The quests a tag of `questId` may move to: the event's other scan quests with NFC on. */
export function moveTargets(
  categories: readonly CategoryView[],
  questId: string,
): readonly Readonly<{ id: string; title: CategoryView["quests"][number]["title"] }>[] {
  return categories.flatMap((category) =>
    category.quests
      .filter(
        (quest) =>
          quest.id !== questId && quest.type === "scan_qr" && quest.verification.includes("nfc"),
      )
      .map((quest) => ({ id: quest.id, title: quest.title })),
  );
}
