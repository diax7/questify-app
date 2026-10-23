import { QR_QUEST_TYPES, QUEST_TYPES } from "@questify/shared";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { audit, done, withEvent, type BuilderDeps, type Done } from "#src/quests/builder";
import {
  questCode,
  questCodeUrl,
  revealCode,
  stepCode,
  type QuestCodeKey,
  type RevealCodeKey,
  type StepCodeKey,
} from "#src/quests/qr";
import {
  bumpQrVersion,
  bumpRevealVersion,
  bumpStepVersion,
  readQuest,
  type Bilingual,
} from "#src/quests/store";

/** What signs the codes and where they point: the dashboard's `/q/{token}` page. */
export type CodeDeps = BuilderDeps &
  Readonly<{
    codeKey: QuestCodeKey;
    stepKey: StepCodeKey;
    revealKey: RevealCodeKey;
    codeOrigin: string;
  }>;

export type QuestCodeView = Readonly<{
  questId: string;
  categoryId: string;
  /** Printed under the title, where the station name will go once stations exist (T-205, T-309). */
  category: Bilingual;
  title: Bilingual;
  /** A passport step's code (T-304b): the step and its name; null for a quest's own code. */
  stepId: string | null;
  step: Bilingual | null;
  version: number;
  url: string;
}>;

/** A hidden category's secret code (T-304c): scanning it in the app shows the category to that player. */
export type SecretCodeView = Readonly<{
  categoryId: string;
  category: Bilingual;
  version: number;
  url: string;
}>;

export type CodesView = Readonly<{ codes: QuestCodeView[]; secrets: SecretCodeView[] }>;

type CodeRow = {
  id: string;
  category_id: string;
  title_ar: string | null;
  title_en: string | null;
  qr_version: number;
  name_ar: string | null;
  name_en: string | null;
  step_id: string | null;
  step_ar: string | null;
  step_en: string | null;
};

const urlOf = (deps: CodeDeps, questId: string, version: number) =>
  questCodeUrl(deps.codeOrigin, questCode(deps.codeKey, questId, version));
const stepUrlOf = (deps: CodeDeps, stepId: string, version: number) =>
  questCodeUrl(deps.codeOrigin, stepCode(deps.stepKey, stepId, version));

const revealUrlOf = (deps: CodeDeps, categoryId: string, version: number) =>
  questCodeUrl(deps.codeOrigin, revealCode(deps.revealKey, categoryId, version));

const codeView = (deps: CodeDeps, row: CodeRow): QuestCodeView => ({
  questId: row.id,
  categoryId: row.category_id,
  category: { ar: row.name_ar, en: row.name_en },
  title: { ar: row.title_ar, en: row.title_en },
  stepId: row.step_id,
  step: row.step_id === null ? null : { ar: row.step_ar, en: row.step_en },
  version: row.qr_version,
  url:
    row.step_id === null
      ? urlOf(deps, row.id, row.qr_version)
      : stepUrlOf(deps, row.step_id, row.qr_version),
});

/**
 * The printed codes of an event (FR-305): one per quest whose type carries a quest QR, and one per passport step
 * (T-304b), in the builder's order; and apart, one secret code per hidden category (T-304c). Members see them because
 * they print them; any status, since an ended event's codes are still looked at.
 */
export function listCodes(deps: CodeDeps, actor: Actor, eventId: string): Promise<Done<CodesView>> {
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
        const { rows } = await client.query<CodeRow>(
          `SELECT q.id, q.category_id, q.title_ar, q.title_en, coalesce(s.qr_version, q.qr_version) AS qr_version,
                  c.name_ar, c.name_en, s.id AS step_id, s.name_ar AS step_ar, s.name_en AS step_en
           FROM quest q JOIN category c ON c.id = q.category_id
           LEFT JOIN passport_step s ON s.quest_id = q.id
           WHERE q.event_id = $1
             AND ((q.type = ANY ($2) AND 'quest_qr' = ANY (q.verification)) OR s.id IS NOT NULL)
           ORDER BY c.position, c.id, q.position, q.id, s.position, s.id`,
          [eventId, QR_QUEST_TYPES],
        );
        const hidden = await client.query<{
          id: string;
          name_ar: string | null;
          name_en: string | null;
          reveal_version: number;
        }>(
          `SELECT id, name_ar, name_en, reveal_version FROM category
           WHERE event_id = $1 AND hidden ORDER BY position, id`,
          [eventId],
        );
        return done({
          codes: rows.map((row) => codeView(deps, row)),
          secrets: hidden.rows.map((row) => ({
            categoryId: row.id,
            category: { ar: row.name_ar, en: row.name_en },
            version: row.reveal_version,
            url: revealUrlOf(deps, row.id, row.reveal_version),
          })),
        });
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

/** Makes a passport step's code new (FR-1711, T-304b), as `regenerateCode` does a quest's. */
export function regenerateStepCode(
  deps: CodeDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; stepId: string }>,
  caller: Caller,
): Promise<Done<Readonly<{ version: number; url: string }>>> {
  return withEvent(deps, actor, target.eventId, { change: undefined }, async (client) => {
    const bumped = await bumpStepVersion(client, target.eventId, target.stepId);
    if (bumped === undefined) {
      return { kind: "not_found" };
    }
    await audit(client, actor, caller, {
      action: "quest.step_qr_regenerate",
      eventId: target.eventId,
      target: { type: "quest", id: bumped.questId },
      before: { stepId: target.stepId, version: bumped.before },
      after: { stepId: target.stepId, version: bumped.version },
    });
    return done({ version: bumped.version, url: stepUrlOf(deps, target.stepId, bumped.version) });
  });
}

/**
 * Makes a hidden category's secret code new (FR-1711, T-304c), as `regenerateCode` does a quest's: a code printed
 * before reveals nothing from then on. Not found for a category that is not hidden.
 */
export function regenerateRevealCode(
  deps: CodeDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; categoryId: string }>,
  caller: Caller,
): Promise<Done<Readonly<{ version: number; url: string }>>> {
  return withEvent(deps, actor, target.eventId, { change: undefined }, async (client) => {
    const version = await bumpRevealVersion(client, target.eventId, target.categoryId);
    if (version === undefined) {
      return { kind: "not_found" };
    }
    await audit(client, actor, caller, {
      action: "category.reveal_regenerate",
      eventId: target.eventId,
      target: { type: "category", id: target.categoryId },
      before: { version: version - 1 },
      after: { version },
    });
    return done({ version, url: revealUrlOf(deps, target.categoryId, version) });
  });
}
