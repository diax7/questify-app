import { QR_QUEST_TYPES, QUEST_TYPES } from "@questify/shared";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { audit, done, withEvent, type BuilderDeps, type Done } from "#src/quests/builder";
import { questCode, questCodeUrl, type QuestCodeKey } from "#src/quests/qr";
import { bumpQrVersion, readQuest, type Bilingual } from "#src/quests/store";

/** What signs the codes and where they point: the dashboard's `/q/{token}` page. */
export type CodeDeps = BuilderDeps & Readonly<{ codeKey: QuestCodeKey; codeOrigin: string }>;

export type QuestCodeView = Readonly<{
  questId: string;
  categoryId: string;
  /** Printed under the title, where the station name will go once stations exist (T-205, T-309). */
  category: Bilingual;
  title: Bilingual;
  version: number;
  url: string;
}>;

const urlOf = (deps: CodeDeps, questId: string, version: number) =>
  questCodeUrl(deps.codeOrigin, questCode(deps.codeKey, questId, version));

/**
 * The printed codes of an event (FR-305): one per quest whose type carries a quest QR, in the builder's order. Members
 * see them because they print them; any status, since an ended event's codes are still looked at.
 */
export function listCodes(
  deps: CodeDeps,
  actor: Actor,
  eventId: string,
): Promise<Done<QuestCodeView[]>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async () => {
        const event = await client.query(
          "SELECT 1 FROM event WHERE organizer_id = $1 AND id = $2",
          [actor.organizerId, eventId],
        );
        if (event.rowCount !== 1) {
          return { kind: "not_found" };
        }
        const { rows } = await client.query<{
          id: string;
          category_id: string;
          title_ar: string | null;
          title_en: string | null;
          qr_version: number;
          name_ar: string | null;
          name_en: string | null;
        }>(
          `SELECT q.id, q.category_id, q.title_ar, q.title_en, q.qr_version, c.name_ar, c.name_en
           FROM quest q JOIN category c ON c.id = q.category_id
           WHERE q.event_id = $1 AND q.type = ANY ($2) AND 'quest_qr' = ANY (q.verification)
           ORDER BY c.position, c.id, q.position, q.id`,
          [eventId, QR_QUEST_TYPES],
        );
        return done(
          rows.map((row) => ({
            questId: row.id,
            categoryId: row.category_id,
            category: { ar: row.name_ar, en: row.name_en },
            title: { ar: row.title_ar, en: row.title_en },
            version: row.qr_version,
            url: urlOf(deps, row.id, row.qr_version),
          })),
        );
      },
    ),
  );
}

/**
 * Makes a quest's code new (FR-1711): the version goes up, so every code printed before stops working at once. The
 * dashboard asks first; a live event needs no second confirmation (UX: none), an ended one refuses. The audit keeps the
 * versions, never a code.
 */
export function regenerateCode(
  deps: CodeDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; questId: string }>,
  caller: Caller,
): Promise<Done<Readonly<{ version: number; url: string }>>> {
  return withEvent(deps, actor, target.eventId, { change: undefined }, async (client) => {
    const quest = await readQuest(client, target.eventId, target.questId, true);
    if (quest === undefined || !QUEST_TYPES[quest.type].usesQuestQr) {
      return { kind: "not_found" };
    }
    const version = await bumpQrVersion(client, quest.id);
    await audit(client, actor, caller, {
      action: "quest.qr_regenerate",
      eventId: target.eventId,
      target: { type: "quest", id: quest.id },
      before: { version: quest.qrVersion },
      after: { version },
    });
    return done({ version, url: urlOf(deps, quest.id, version) });
  });
}
