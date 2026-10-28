import { memberAnnouncementSchema, type MemberAnnouncement } from "@questify/shared";
import type { Category, Quest } from "#src/event/quests-api.ts";

export function memberAnnouncementsOf(body: unknown): MemberAnnouncement[] | undefined {
  const list =
    typeof body === "object" && body !== null
      ? (body as { announcements?: unknown }).announcements
      : undefined;
  const result = memberAnnouncementSchema.array().safeParse(list);
  return result.success ? result.data : undefined;
}

export type Happening = Readonly<{ id: string; kind: "flash" | "boost"; title: Category["name"] }>;
const running = (window: Readonly<{ endsAt: string }> | null, now: number): boolean =>
  window !== null && Date.parse(window.endsAt) > now;
const flashRunning = (quest: Quest, now: number): boolean =>
  quest.flash !== null && Date.parse(quest.flash.closesAt) > now;

export function happeningNow(categories: readonly Category[], now: number): Happening[] {
  return categories.flatMap((category) => {
    const rows: Happening[] = [];
    if (
      running(category.boost, now) ||
      category.quests.some((quest) => running(quest.boost, now))
    ) {
      rows.push({ id: "boost:" + category.id, kind: "boost", title: category.name });
    }
    return rows.concat(
      category.quests
        .filter((quest) => flashRunning(quest, now))
        .map((quest) => ({ id: "flash:" + quest.id, kind: "flash" as const, title: quest.title })),
    );
  });
}
