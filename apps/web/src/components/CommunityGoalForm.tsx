"use client";

import type { Language } from "@questify/shared";
import {
  MAX_MILESTONES,
  blankReward,
  previewFills,
  type GoalDraft,
  type Measure,
  type RewardDraft,
  type TargetChoice,
  type UnlockKind,
} from "#src/lib/community.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Meter, Muted } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Select } from "#src/ui/Field.tsx";
import { Card, Toolbar } from "#src/ui/Section.tsx";

/** A quest or category the goal may count. */
export type Choice = Readonly<{ id: string; name: string }>;

type Change = (next: GoalDraft) => void;
/** The picker's choices for a kind of target, for this draft (`targetChoices`). */
export type Targets = (kind: UnlockKind) => readonly TargetChoice[];

function TextField({
  label,
  value,
  disabled,
  change,
  dir,
  maxLength,
}: Readonly<{
  label: string;
  value: string;
  disabled: boolean;
  change: (value: string) => void;
  dir: "rtl" | "ltr" | "auto";
  maxLength: number;
}>) {
  return (
    <Field label={label}>
      <Input
        dir={dir}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      />
    </Field>
  );
}

/**
 * An unlock's target (T-306c, ADR-227): a quest, a category or a shop reward, from what the goal may unlock; one
 * another goal unlocks is shown but cannot be picked. The note says it is locked from the save.
 */
function UnlockFields({
  language,
  reward,
  locked,
  busy,
  change,
  targets,
}: Readonly<{
  language: Language;
  reward: RewardDraft;
  locked: boolean;
  busy: boolean;
  change: (next: RewardDraft) => void;
  targets: Targets;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <Select
        value={reward.targetKind}
        disabled={busy || locked}
        aria-label={t("community.page.unlock.target")}
        onChange={(event) =>
          change({ ...reward, targetKind: event.target.value as UnlockKind, targetId: "" })
        }
      >
        {(["quest", "category", "reward"] as const).map((kind) => (
          <option key={kind} value={kind}>
            {t(`community.page.unlock.${kind}`)}
          </option>
        ))}
      </Select>
      <Select
        value={reward.targetId}
        disabled={busy || locked}
        aria-label={t(`community.page.unlock.${reward.targetKind}`)}
        onChange={(event) => change({ ...reward, targetId: event.target.value })}
      >
        <option value="" />
        {targets(reward.targetKind).map((choice) => (
          <option
            key={choice.id}
            value={choice.id}
            disabled={choice.taken && choice.id !== reward.targetId}
          >
            {choice.taken ? t("community.page.unlock.taken", { name: choice.name }) : choice.name}
          </option>
        ))}
      </Select>
      <Muted as="span">{t("community.page.unlock.note")}</Muted>
    </>
  );
}

/** A reward's kind and its points, moment texts or unlock; once started only the moment texts stay editable. */
function RewardFields({
  language,
  reward,
  locked,
  busy,
  change,
  targets,
}: Readonly<{
  language: Language;
  reward: RewardDraft;
  locked: boolean;
  busy: boolean;
  change: (next: RewardDraft) => void;
  targets: Targets;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <Select
        value={reward.kind}
        disabled={busy || locked}
        aria-label={t("community.page.goalReward")}
        onChange={(event) => change({ ...reward, kind: event.target.value as RewardDraft["kind"] })}
      >
        {(["points", "moment", "nothing", "unlock"] as const).map((kind) => (
          <option key={kind} value={kind}>
            {t(`community.page.reward.${kind}`)}
          </option>
        ))}
      </Select>
      {reward.kind === "points" ? (
        <TextField
          label={t("community.page.points")}
          value={reward.points}
          disabled={busy || locked}
          change={(points) => change({ ...reward, points })}
          dir="ltr"
          maxLength={6}
        />
      ) : null}
      {reward.kind === "moment" ? (
        <>
          <TextField
            label={t("community.page.momentAr")}
            value={reward.momentAr}
            disabled={busy}
            change={(momentAr) => change({ ...reward, momentAr })}
            dir="rtl"
            maxLength={280}
          />
          <TextField
            label={t("community.page.momentEn")}
            value={reward.momentEn}
            disabled={busy}
            change={(momentEn) => change({ ...reward, momentEn })}
            dir="ltr"
            maxLength={280}
          />
        </>
      ) : null}
      {reward.kind === "unlock" ? (
        <UnlockFields
          language={language}
          reward={reward}
          locked={locked}
          busy={busy}
          change={change}
          targets={targets}
        />
      ) : null}
    </>
  );
}

/** What counts and from which quests: points count every quest; completions and players may take one quest or category. */
function ScopeFields({
  language,
  draft,
  locked,
  busy,
  change,
  quests,
  categories,
}: Readonly<{
  language: Language;
  draft: GoalDraft;
  locked: boolean;
  busy: boolean;
  change: Change;
  quests: readonly Choice[];
  categories: readonly Choice[];
}>) {
  const t = useTranslator(language);
  const choices = draft.scope === "quest" ? quests : categories;
  return (
    <>
      <Field label={t("community.page.measure")}>
        <Select
          value={draft.measure}
          disabled={busy || locked}
          onChange={(event) => change({ ...draft, measure: event.target.value as Measure })}
        >
          {(["points", "completions", "players"] as const).map((measure) => (
            <option key={measure} value={measure}>
              {t(`community.measure.${measure}`)}
            </option>
          ))}
        </Select>
      </Field>
      {draft.measure === "points" ? null : (
        <Field label={t("community.page.scope")}>
          <Select
            value={draft.scope}
            disabled={busy || locked}
            onChange={(event) =>
              change({ ...draft, scope: event.target.value as GoalDraft["scope"] })
            }
          >
            {(["all", "quest", "category"] as const).map((scope) => (
              <option key={scope} value={scope}>
                {t(`community.page.scope.${scope}`)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {draft.measure === "points" || draft.scope === "all" ? null : (
        <Select
          aria-label={t(`community.page.scope.${draft.scope}`)}
          value={draft.scope === "quest" ? draft.questId : draft.categoryId}
          disabled={busy || locked}
          onChange={(event) =>
            change(
              draft.scope === "quest"
                ? { ...draft, questId: event.target.value }
                : { ...draft, categoryId: event.target.value },
            )
          }
        >
          <option value="" />
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.name}
            </option>
          ))}
        </Select>
      )}
    </>
  );
}

/** Up to 5 milestones below the target, each with its reward. */
function MilestoneFields({
  language,
  draft,
  locked,
  busy,
  change,
  targets,
}: Readonly<{
  language: Language;
  draft: GoalDraft;
  locked: boolean;
  busy: boolean;
  change: Change;
  targets: Targets;
}>) {
  const t = useTranslator(language);
  const set = (index: number, next: GoalDraft["milestones"][number]) =>
    change({
      ...draft,
      milestones: draft.milestones.map((step, at) => (at === index ? next : step)),
    });
  return (
    <FieldGroup>
      <legend>{t("community.page.milestones")}</legend>
      {draft.milestones.map((step, index) => (
        <Card key={index}>
          <TextField
            label={t("community.page.threshold")}
            value={step.threshold}
            disabled={busy || locked}
            change={(threshold) => set(index, { ...step, threshold })}
            dir="ltr"
            maxLength={10}
          />
          <RewardFields
            language={language}
            reward={step}
            locked={locked}
            busy={busy}
            change={(reward) => set(index, { ...step, ...reward })}
            targets={targets}
          />
          {locked ? null : (
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() =>
                change({ ...draft, milestones: draft.milestones.filter((_, at) => at !== index) })
              }
            >
              {t("community.page.removeMilestone")}
            </Button>
          )}
        </Card>
      ))}
      {locked || draft.milestones.length >= MAX_MILESTONES ? null : (
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() =>
            change({
              ...draft,
              milestones: [
                ...draft.milestones,
                { ...blankReward(), kind: "nothing", threshold: "" },
              ],
            })
          }
        >
          {t("community.page.addMilestone")}
        </Button>
      )}
    </FieldGroup>
  );
}

/**
 * The bar as players see it at the start and at the first milestone (goals never run in rehearsal, Q-186), with each
 * unlock marker as a player who sees its target reads it.
 */
function BarPreview({
  language,
  draft,
  targets,
}: Readonly<{ language: Language; draft: GoalDraft; targets: Targets }>) {
  const t = useTranslator(language);
  const unlocks = [draft.reward, ...draft.milestones]
    .filter((reward) => reward.kind === "unlock" && reward.targetId !== "")
    .map(
      (reward) =>
        targets(reward.targetKind).find((choice) => choice.id === reward.targetId)?.name ?? "",
    )
    .filter((name) => name !== "");
  return (
    <FieldGroup>
      <strong>{t("community.page.preview")}</strong>
      <Muted as="span">{t("community.page.previewNote")}</Muted>
      {previewFills(draft).map((fill) => (
        <Meter key={fill} share={fill} />
      ))}
      {unlocks.map((name) => (
        <span key={name}>{t("community.reward.unlock", { name })}</span>
      ))}
    </FieldGroup>
  );
}

/** The goal's form: titles, what counts, the target and window, who is paid, the goal's reward and milestones. */
export function CommunityGoalForm({
  language,
  draft,
  change,
  quests,
  categories,
  targets,
  busy,
  save,
  cancel,
}: Readonly<{
  language: Language;
  draft: GoalDraft;
  change: Change;
  quests: readonly Choice[];
  categories: readonly Choice[];
  targets: Targets;
  busy: boolean;
  save: () => void;
  cancel: () => void;
}>) {
  const t = useTranslator(language);
  const locked = draft.started;
  const time = (field: "startsAt" | "endsAt") => (
    <Field label={t(field === "startsAt" ? "community.page.startsAt" : "community.page.endsAt")}>
      <Input
        type="datetime-local"
        dir="ltr"
        value={draft[field]}
        disabled={busy || locked}
        onChange={(event) => change({ ...draft, [field]: event.target.value })}
      />
    </Field>
  );
  return (
    <Form
      card
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {locked ? <Muted>{t("community.page.lockedNote")}</Muted> : null}
      <TextField
        label={t("community.page.titleAr")}
        value={draft.titleAr}
        disabled={busy}
        change={(titleAr) => change({ ...draft, titleAr })}
        dir="rtl"
        maxLength={80}
      />
      <TextField
        label={t("community.page.titleEn")}
        value={draft.titleEn}
        disabled={busy}
        change={(titleEn) => change({ ...draft, titleEn })}
        dir="ltr"
        maxLength={80}
      />
      <Muted>{t("community.page.titleHint")}</Muted>
      <ScopeFields
        language={language}
        draft={draft}
        locked={locked}
        busy={busy}
        change={change}
        quests={quests}
        categories={categories}
      />
      <TextField
        label={t("community.page.target")}
        value={draft.target}
        disabled={busy || locked}
        change={(target) => change({ ...draft, target })}
        dir="ltr"
        maxLength={10}
      />
      {time("startsAt")}
      {time("endsAt")}
      <Field label={t("community.page.paidTo")}>
        <Select
          value={draft.paidTo}
          disabled={busy || locked}
          onChange={(event) =>
            change({ ...draft, paidTo: event.target.value as GoalDraft["paidTo"] })
          }
        >
          <option value="contributors">{t("community.page.paidTo.contributors")}</option>
          <option value="everyone">{t("community.page.paidTo.everyone")}</option>
        </Select>
      </Field>
      <FieldGroup>
        <legend>{t("community.page.goalReward")}</legend>
        <RewardFields
          language={language}
          reward={draft.reward}
          locked={locked}
          busy={busy}
          change={(reward) => change({ ...draft, reward })}
          targets={targets}
        />
      </FieldGroup>
      <MilestoneFields
        language={language}
        draft={draft}
        locked={locked}
        busy={busy}
        change={change}
        targets={targets}
      />
      <BarPreview language={language} draft={draft} targets={targets} />
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("community.page.save")}
        </Button>
      </Toolbar>
    </Form>
  );
}
