import {
  decodeCursor,
  encodeCursor,
  type Equipment,
  type ProfileItem,
  type LockerEntry,
} from "@questify/shared";
import type { PoolClient } from "pg";
import { z } from "zod";
import { invalidRequest, unauthenticated } from "#src/auth/http-errors";
import { HttpError } from "#src/http-error";

export const itemNotOwned = () =>
  new HttpError(422, "item_not_owned", {
    ar: "العنصر غير متاح لك. اختر عنصرًا من خزانتك.",
    en: "That item is unavailable. Choose an item from your locker.",
  });

/** Narrow database refusals, never exception details (which may include submitted text). */
export function itemRefusal(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === "PI401") throw unauthenticated();
  if (code === "PI422") throw itemNotOwned();
  throw error;
}

export async function readEquipment(
  client: PoolClient,
): Promise<{ equipment: Equipment; next_reward: ProfileItem | null }> {
  const { rows } = await client.query<{ equipment: Equipment; next_reward: ProfileItem | null }>(
    "SELECT equipment,next_reward FROM own_equipment()",
  );
  if (rows[0] === undefined) throw unauthenticated();
  return rows[0];
}

const positionSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  id: z.string().min(1).max(64),
});
export type LockerItem = LockerEntry;

/** Where a locker item came from: a level, an event's souvenir or the gem shop (T-404). */
function sourceOf(
  row: Readonly<{
    source: "level" | "souvenir" | "shop";
    source_level: number;
    source_event: Extract<LockerEntry["source"], { kind: "event" }>["event"] | null;
  }>,
): LockerEntry["source"] {
  if (row.source === "shop") return { kind: "shop" };
  if (row.source_event === null) return { kind: "level", level: row.source_level };
  return { kind: "event", event: row.source_event };
}
export async function readLocker(client: PoolClient, cursor: string | undefined, limit: number) {
  let before: z.infer<typeof positionSchema> | undefined;
  if (cursor !== undefined) {
    try {
      const result = positionSchema.safeParse(decodeCursor(cursor));
      if (!result.success) throw invalidRequest();
      before = result.data;
    } catch {
      throw invalidRequest();
    }
  }
  const { rows } = await client.query<{
    item: ProfileItem;
    earned_at: string;
    source_level: number;
    source_event: Extract<LockerEntry["source"], { kind: "event" }>["event"] | null;
    seen: boolean;
    source: "level" | "souvenir" | "shop";
  }>(
    `SELECT item,to_char(earned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS earned_at,source_level,source_event,seen,source FROM own_locker($1,$2,$3)`,
    [before?.at ?? null, before?.id ?? null, limit + 1],
  );
  const items: LockerItem[] = rows.slice(0, limit).map((row) => ({
    item: row.item,
    earnedAt: row.earned_at,
    source: sourceOf(row),
    seen: row.seen,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ at: last.earnedAt, id: last.item.id })
        : null,
  };
}
