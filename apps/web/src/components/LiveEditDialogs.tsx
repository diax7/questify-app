"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { useQuestBuilder } from "#src/components/useQuestBuilder.ts";
import { textFor, type QuestView } from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { FieldGroup, Radio } from "#src/ui/Field.tsx";

/** The screen's numbers for new points, from `GET …/quests/{id}/impact` (T-604, FR-413). */
export type PointsImpact = Readonly<{
  eligible: boolean;
  completions: number;
  players: number;
  raise: number;
  lower: number;
  clamped: number;
  prizesHanded: number;
}>;

const KEYS = ["completions", "players", "raise", "lower", "clamped", "prizesHanded"] as const;

/** The impact answer, or undefined when the body is not that shape. */
export function pointsImpactOf(body: unknown): PointsImpact | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = body as Record<string, unknown>;
  if (
    typeof value["eligible"] !== "boolean" ||
    !KEYS.every((key) => typeof value[key] === "number")
  ) {
    return undefined;
  }
  return value as PointsImpact;
}

/**
 * New points for a quest real players completed (FR-411, FR-413): the real counts, and future completions only or also
 * past ones, neither chosen for the person; a type paid its own amounts gets one line and no choice (Q-354). Every past
 * change is described as a new entry in the points record.
 */
export function PointsDialog({
  language,
  title,
  impact,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  title: string;
  impact: PointsImpact;
  busy: boolean;
  cancel: () => void;
  confirm: (apply: "future" | "past") => void;
}>) {
  const t = useTranslator(language);
  const [choice, setChoice] = useState<"future" | "past" | null>(impact.eligible ? null : "future");
  const n = (value: number) => formatNumber(value, language);
  return (
    <Dialog
      titleId="points-title"
      title={t("quests.points.title", { title })}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || choice === null}
            onClick={() => (choice === null ? undefined : confirm(choice))}
          >
            {t("quests.points.save")}
          </Button>
        </>
      }
    >
      <p>
        {t("quests.points.reach", {
          completions: n(impact.completions),
          players: n(impact.players),
        })}
      </p>
      {impact.eligible ? (
        <FieldGroup legend={t("quests.points.choose")} layout="choices">
          <Radio
            label={t("quests.points.future")}
            name="apply"
            checked={choice === "future"}
            onChange={() => setChoice("future")}
          />
          <Radio
            label={t("quests.points.past", { raise: n(impact.raise), lower: n(impact.lower) })}
            name="apply"
            checked={choice === "past"}
            onChange={() => setChoice("past")}
          />
        </FieldGroup>
      ) : (
        <p>{t("quests.points.ownAmounts")}</p>
      )}
      {choice === "past" && impact.clamped > 0 ? (
        <p>{t("quests.points.clamped", { count: n(impact.clamped) })}</p>
      ) : null}
      {choice === "past" && impact.prizesHanded > 0 ? <p>{t("quests.points.prizes")}</p> : null}
    </Dialog>
  );
}

/**
 * Deleting a quest real players completed (FR-412): keep their points or remove them, neither chosen for the person.
 */
export function PlayedDeleteDialog({
  language,
  name,
  impact,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  name: string;
  impact: PointsImpact;
  busy: boolean;
  cancel: () => void;
  confirm: (points: "keep" | "remove") => void;
}>) {
  const t = useTranslator(language);
  const [choice, setChoice] = useState<"keep" | "remove" | null>(null);
  const n = (value: number) => formatNumber(value, language);
  return (
    <Dialog
      titleId="played-delete-title"
      title={t("quests.deleteTitle")}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={busy || choice === null}
            onClick={() => (choice === null ? undefined : confirm(choice))}
          >
            {t("quests.delete")}
          </Button>
        </>
      }
    >
      <FieldGroup
        legend={t("quests.deletePlayed.legend", {
          name,
          completions: n(impact.completions),
          players: n(impact.players),
        })}
        layout="choices"
      >
        <Radio
          label={t("quests.deletePlayed.keep")}
          name="points"
          checked={choice === "keep"}
          onChange={() => setChoice("keep")}
        />
        <Radio
          label={t("quests.deletePlayed.remove")}
          name="points"
          checked={choice === "remove"}
          onChange={() => setChoice("remove")}
        />
      </FieldGroup>
    </Dialog>
  );
}

type Builder = Pick<ReturnType<typeof useQuestBuilder>, "busy" | "send" | "read">;
type Pointing = Readonly<{
  quest: QuestView;
  body: Readonly<Record<string, unknown>>;
  impact: PointsImpact;
  key: string;
  after: () => void;
}>;
type Played = Readonly<{ quest: QuestView; impact: PointsImpact }>;

/**
 * The live points edits of the quest builder (T-604): before new points on a played quest in a live event are saved,
 * and before a played quest is deleted, the real numbers are read and the choice asked. Anything else goes on as
 * before (`false`: the caller sends it).
 */
export function useLiveEdits({
  language,
  builder,
  live,
  focus,
}: Readonly<{
  language: Language;
  builder: Builder;
  live: boolean;
  focus: Readonly<{ restore: () => void }>;
}>) {
  const [pointing, setPointing] = useState<Pointing | null>(null);
  const [played, setPlayed] = useState<Played | null>(null);
  const impactOf = async (quest: QuestView, points: number) =>
    live
      ? pointsImpactOf(await builder.read(`/quests/${quest.id}/impact?points=${points}`))
      : undefined;

  const askPoints = async (pending: Omit<Pointing, "impact">): Promise<boolean> => {
    const points = pending.body["points"];
    if (typeof points !== "number" || points === pending.quest.points) {
      return false;
    }
    const impact = await impactOf(pending.quest, points);
    if (impact === undefined || impact.completions === 0) {
      return false;
    }
    setPointing({ ...pending, impact });
    return true;
  };
  const askDelete = async (quest: QuestView): Promise<boolean> => {
    const impact = await impactOf(quest, quest.points);
    if (impact === undefined || impact.completions === 0) {
      return false;
    }
    setPlayed({ quest, impact });
    return true;
  };
  const close = () => {
    setPointing(null);
    setPlayed(null);
    focus.restore();
  };

  const dialogs = (
    <>
      {pointing === null ? null : (
        <PointsDialog
          language={language}
          title={textFor(pointing.quest.title, language)}
          impact={pointing.impact}
          busy={builder.busy}
          cancel={close}
          confirm={(apply) => {
            setPointing(null);
            void builder.send(
              "PATCH",
              `/quests/${pointing.quest.id}`,
              { ...pointing.body, apply, confirm: true },
              { key: pointing.key, after: pointing.after },
            );
          }}
        />
      )}
      {played === null ? null : (
        <PlayedDeleteDialog
          language={language}
          name={textFor(played.quest.title, language)}
          impact={played.impact}
          busy={builder.busy}
          cancel={close}
          confirm={(points) => {
            setPlayed(null);
            void builder
              .send("DELETE", `/quests/${played.quest.id}`, { confirm: true, points })
              .then(() => focus.restore());
          }}
        />
      )}
    </>
  );
  return { askPoints, askDelete, dialogs };
}
