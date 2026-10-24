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
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

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
    <label className={styles.field}>
      <span>{label}</span>
      <input
        className={styles.input}
        dir={dir}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      />
    </label>
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
  const t = translatorFor(language);
  return (
    <>
      <select
        className={styles.input}
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
      </select>
      <select
        className={styles.input}
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
      </select>
      <span className={styles.muted}>{t("community.page.unlock.note")}</span>
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
  const t = translatorFor(language);
  return (
    <>
      <select
        className={styles.input}
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
      </select>
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
  const t = translatorFor(language);
  const choices = draft.scope === "quest" ? quests : categories;
  return (
    <>
      <label className={styles.field}>
        <span>{t("community.page.measure")}</span>
        <select
          className={styles.input}
          value={draft.measure}
          disabled={busy || locked}
          onChange={(event) => change({ ...draft, measure: event.target.value as Measure })}
        >
          {(["points", "completions", "players"] as const).map((measure) => (
            <option key={measure} value={measure}>
              {t(`community.measure.${measure}`)}
            </option>
          ))}
        </select>
      </label>
      {draft.measure === "points" ? null : (
        <label className={styles.field}>
          <span>{t("community.page.scope")}</span>
          <select
            className={styles.input}
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
          </select>
        </label>
      )}
      {draft.measure === "points" || draft.scope === "all" ? null : (
        <select
          className={styles.input}
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
        </select>
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
  const t = translatorFor(language);
  const set = (index: number, next: GoalDraft["milestones"][number]) =>
    change({
      ...draft,
      milestones: draft.milestones.map((step, at) => (at === index ? next : step)),
    });
  return (
    <fieldset className={styles.form}>
      <legend>{t("community.page.milestones")}</legend>
      {draft.milestones.map((step, index) => (
        <div key={index} className={styles.formCard}>
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
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() =>
                change({ ...draft, milestones: draft.milestones.filter((_, at) => at !== index) })
              }
            >
              {t("community.page.removeMilestone")}
            </button>
          )}
        </div>
      ))}
      {locked || draft.milestones.length >= MAX_MILESTONES ? null : (
        <button
          type="button"
          className={styles.quiet}
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
        </button>
      )}
    </fieldset>
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
  const t = translatorFor(language);
  const unlocks = [draft.reward, ...draft.milestones]
    .filter((reward) => reward.kind === "unlock" && reward.targetId !== "")
    .map(
      (reward) =>
        targets(reward.targetKind).find((choice) => choice.id === reward.targetId)?.name ?? "",
    )
    .filter((name) => name !== "");
  return (
    <div className={styles.form}>
      <strong>{t("community.page.preview")}</strong>
      <span className={styles.muted}>{t("community.page.previewNote")}</span>
      {previewFills(draft).map((fill) => (
        <div key={fill} className={styles.meter} aria-hidden="true">
          <div className={styles.meterFill} style={{ inlineSize: `${fill * 100}%` }} />
        </div>
      ))}
      {unlocks.map((name) => (
        <span key={name}>{t("community.reward.unlock", { name })}</span>
      ))}
    </div>
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
  const t = translatorFor(language);
  const locked = draft.started;
  const time = (field: "startsAt" | "endsAt") => (
    <label className={styles.field}>
      <span>{t(field === "startsAt" ? "community.page.startsAt" : "community.page.endsAt")}</span>
      <input
        className={styles.input}
        type="datetime-local"
        dir="ltr"
        value={draft[field]}
        disabled={busy || locked}
        onChange={(event) => change({ ...draft, [field]: event.target.value })}
      />
    </label>
  );
  return (
    <form
      className={styles.formCard}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {locked ? <p className={styles.muted}>{t("community.page.lockedNote")}</p> : null}
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
      <p className={styles.muted}>{t("community.page.titleHint")}</p>
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
      <label className={styles.field}>
        <span>{t("community.page.paidTo")}</span>
        <select
          className={styles.input}
          value={draft.paidTo}
          disabled={busy || locked}
          onChange={(event) =>
            change({ ...draft, paidTo: event.target.value as GoalDraft["paidTo"] })
          }
        >
          <option value="contributors">{t("community.page.paidTo.contributors")}</option>
          <option value="everyone">{t("community.page.paidTo.everyone")}</option>
        </select>
      </label>
      <fieldset className={styles.form}>
        <legend>{t("community.page.goalReward")}</legend>
        <RewardFields
          language={language}
          reward={draft.reward}
          locked={locked}
          busy={busy}
          change={(reward) => change({ ...draft, reward })}
          targets={targets}
        />
      </fieldset>
      <MilestoneFields
        language={language}
        draft={draft}
        locked={locked}
        busy={busy}
        change={change}
        targets={targets}
      />
      <BarPreview language={language} draft={draft} targets={targets} />
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("community.page.save")}
        </button>
      </div>
    </form>
  );
}
