"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import {
  CommunityGoalForm,
  type Choice,
  type Targets,
} from "#src/components/CommunityGoalForm.tsx";
import {
  MEASURE_KEYS,
  STATUS_KEYS,
  blankGoal,
  goalBodyOf,
  goalDraftOf,
  goalsOf,
  isLive,
  issuesOf,
  takenTargets,
  targetChoices,
  type Bilingual,
  type Goal,
  type GoalDraft,
  type UnlockOptions,
} from "#src/lib/community.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
/** An unlock the API refused, in words (T-306c). */
const UNLOCK_ISSUES = {
  unlock_target: "community.page.issue.unlockTarget",
  unlock_counted: "community.page.issue.unlockCounted",
} as const;
const NO_OPTIONS: UnlockOptions = { quests: [], categories: [], rewards: [] };
/** How often a running goal's progress and payouts are read again. */
const REFRESH_MS = 5000;

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/** The event's zone, its quests and categories for the form's selects, and what a step may unlock (T-306c). */
function useEventChoices(eventApi: string, language: Language) {
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [options, setOptions] = useState<UnlockOptions>(NO_OPTIONS);
  useEffect(() => {
    void Promise.all([
      requestJson("GET", eventApi),
      requestJson("GET", `${eventApi}/quests`),
      requestJson("GET", `${eventApi}/rewards`),
    ]).then(([event, found, shop]) => {
      const zone = event.ok
        ? (event.body as { event?: { timezone?: string } }).event?.timezone
        : undefined;
      setTimeZone(zone ?? "Asia/Riyadh");
      const list = found.ok ? (found.body as { categories: CategoryView[] }).categories : [];
      const rewards = shop.ok
        ? ((shop.body as { rewards?: { id: string; name: Bilingual }[] }).rewards ?? [])
        : [];
      setOptions({
        categories: list.map((category) => ({
          id: category.id,
          name: textFor(category.name, language),
        })),
        quests: list.flatMap((category) =>
          category.quests.map((quest) => ({
            id: quest.id,
            name: textFor(quest.title, language),
            categoryId: category.id,
            livePoll: quest.type === "vote" && "live" in quest.config,
          })),
        ),
        rewards: rewards.map((reward) => ({ id: reward.id, name: textFor(reward.name, language) })),
      });
    });
  }, [eventApi, language]);
  const quests: readonly Choice[] = options.quests;
  const categories: readonly Choice[] = options.categories;
  return { timeZone, quests, categories, options };
}

/** The goals, read again every 5 s while one is running. */
function useGoals(eventApi: string, language: Language) {
  const t = translatorFor(language);
  const [goals, setGoals] = useState<readonly Goal[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const failed = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      if (code === "invalid_goal") {
        const issues = issuesOf(body);
        const unlock = issues.find((issue) => issue in UNLOCK_ISSUES);
        setProblem(
          unlock === undefined
            ? t("community.page.invalid", { fields: issues.join("، ") })
            : t(UNLOCK_ISSUES[unlock as keyof typeof UNLOCK_ISSUES]),
        );
        return;
      }
      setProblem(
        code === undefined
          ? t("community.page.loadFailed")
          : describeProblem(body, language, t).text,
      );
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/community-goals`);
    const read = result.ok ? goalsOf(result.body) : undefined;
    if (read === undefined) {
      failed(result.body);
    } else {
      setGoals(read);
    }
  }, [eventApi, failed]);
  useEffect(() => {
    void load();
  }, [load]);
  const running = goals?.some(isLive) === true;
  useEffect(() => {
    if (!running) {
      return undefined;
    }
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, load]);
  return { goals, problem, setProblem, failed, load };
}

/** One goal: its window, what counts, the bar and each step with its payouts; Edit and, before its start, Delete. */
function GoalCard({
  goal,
  language,
  timeZone,
  busy,
  edit,
  remove,
}: Readonly<{
  goal: Goal;
  language: Language;
  timeZone: string;
  busy: boolean;
  edit: () => void;
  remove: () => void;
}>) {
  const t = translatorFor(language);
  const at = (iso: string) => formatEventTime(new Date(iso), timeZone, language);
  const share = goal.target === 0 ? 0 : Math.min(1, goal.progress / goal.target);
  const progress = t("community.progress", {
    progress: formatNumber(goal.progress, language),
    target: formatNumber(goal.target, language),
  });
  return (
    <li className={styles.formCard}>
      <p className={styles.row}>
        <strong dir="auto">{textFor(goal.title, language)}</strong>
        <span className={styles.badge}>{t(STATUS_KEYS[goal.status])}</span>
      </p>
      <p className={styles.muted}>
        {t("community.page.window", { start: at(goal.startsAt), end: at(goal.closesAt) })}
      </p>
      <p>{t(MEASURE_KEYS[goal.measure])}</p>
      <div
        className={styles.meter}
        role="progressbar"
        aria-label={t("community.bar")}
        aria-valuemin={0}
        aria-valuemax={goal.target}
        aria-valuenow={Math.min(goal.progress, goal.target)}
        aria-valuetext={progress}
      >
        <div className={styles.meterFill} style={{ inlineSize: `${share * 100}%` }} />
      </div>
      <p>{progress}</p>
      <ul className={styles.list}>
        {goal.steps.map((step) => (
          <li key={step.threshold} className={styles.row}>
            <span>{formatNumber(step.threshold, language)}</span>
            <span>{t(`community.page.reward.${step.reward.kind}`)}</span>
            {step.reward.unlock === null ? null : (
              <span dir="auto">
                {t("community.page.unlocks", { name: textFor(step.reward.unlock.name, language) })}
              </span>
            )}
            {step.reward.points === null ? null : (
              <span>{formatNumber(step.reward.points, language)}</span>
            )}
            {step.reachedAt === null ? null : (
              <span className={styles.badge}>{at(step.reachedAt)}</span>
            )}
            {step.reward.kind === "points" && step.reachedAt !== null ? (
              <span className={styles.muted}>
                {t("community.page.payouts", {
                  paid: formatNumber(step.paid, language),
                  due: formatNumber(step.due, language),
                  skipped: formatNumber(step.skipped, language),
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={edit}>
          {t("community.page.edit")}
        </button>
        {goal.started ? null : (
          <button type="button" className={styles.quiet} disabled={busy} onClick={remove}>
            {t("community.page.delete")}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The event's community quests (T-306b, FR-243 to FR-250): the goals with their progress (read every 5 s while one
 * runs) and payouts, a form to add or change one (only texts once it started), Delete before the start, and a static
 * preview of the bar (goals never run in rehearsal, Q-186). Owners and editors.
 */
export function CommunityPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { timeZone, quests, categories, options } = useEventChoices(eventApi, language);
  const { goals, problem, setProblem, failed, load } = useGoals(eventApi, language);
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const targetsFor =
    (current: GoalDraft): Targets =>
    (kind) =>
      targetChoices(kind, options, current, takenTargets(goals ?? [], current.id));

  const save = async () => {
    if (draft === null) {
      return;
    }
    const original = goals?.find((goal) => goal.id === draft.id);
    setBusy(true);
    const result = await requestJson(
      draft.id === null ? "POST" : "PATCH",
      `${eventApi}/community-goals${draft.id === null ? "" : `/${draft.id}`}`,
      goalBodyOf(draft, timeZone, original),
      { "idempotency-key": crypto.randomUUID() },
    );
    setBusy(false);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    setProblem(null);
    setDraft(null);
    setNotice(t("community.page.saved"));
    await load();
  };
  const remove = async (goal: Goal) => {
    setBusy(true);
    const result = await requestJson(
      "DELETE",
      `${eventApi}/community-goals/${goal.id}`,
      undefined,
      {
        "idempotency-key": crypto.randomUUID(),
      },
    );
    setBusy(false);
    setDeleting(null);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    setNotice(t("community.page.deleted"));
    await load();
  };

  return (
    <section className={styles.panel} aria-labelledby="community-title">
      <h2 id="community-title" className={styles.title}>
        {t("community.page.title")}
      </h2>
      <p className={styles.muted}>{t("community.page.intro")}</p>
      <Notes
        problem={problem}
        notice={notice}
        loading={goals === null && problem === null}
        language={language}
      />
      {deleting === null ? null : (
        <ConfirmDialog
          language={language}
          title={t("community.page.deleteTitle")}
          body={t("community.page.deleteBody")}
          confirmLabel={t("community.page.delete")}
          noteLabel={null}
          busy={busy}
          cancel={() => setDeleting(null)}
          confirm={() => void remove(deleting)}
        />
      )}
      <div className={styles.form} inert={deleting !== null}>
        {goals !== null && goals.length === 0 ? (
          <p className={styles.muted}>{t("community.page.empty")}</p>
        ) : null}
        <ul className={styles.list}>
          {(goals ?? []).map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              language={language}
              timeZone={timeZone}
              busy={busy}
              edit={() => setDraft(goalDraftOf(goal, timeZone))}
              remove={() => setDeleting(goal)}
            />
          ))}
        </ul>
        {draft === null ? (
          <button
            type="button"
            className={styles.button}
            onClick={() => setDraft(blankGoal(Date.now(), timeZone))}
          >
            {t("community.page.new")}
          </button>
        ) : (
          <CommunityGoalForm
            language={language}
            draft={draft}
            change={setDraft}
            quests={quests}
            categories={categories}
            targets={targetsFor(draft)}
            busy={busy}
            save={() => void save()}
            cancel={() => setDraft(null)}
          />
        )}
      </div>
    </section>
  );
}
