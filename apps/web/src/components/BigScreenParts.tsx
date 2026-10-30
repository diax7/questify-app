import { formatNumber, type Language } from "@questify/shared";
import type { translatorFor } from "#src/lib/language.ts";
import { avatarFile, percentOf, type CommunityGoal, type RankingRow } from "#src/lib/big-screen.ts";
import { textFor } from "#src/lib/quests.ts";
import styles from "#src/components/device.module.css";

type Translate = ReturnType<typeof translatorFor>;

/** A player's picture on a big-screen board: Questify's own avatar, or the first letter of the name. */
export function Avatar({ row }: Readonly<{ row: Pick<RankingRow, "avatar" | "username"> }>) {
  const file = avatarFile(row.avatar);
  return file === null ? (
    <span className={styles.boardAvatar} aria-hidden="true">
      {row.username.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img
      className={styles.boardAvatar}
      src={`/avatars/${file}.png`}
      alt=""
      width={51}
      height={51}
    />
  );
}

/** A community goal's title, bar with its milestones, numbers and how it ended (the community scene and the finale's push). */
export function CommunityScene({
  goal,
  language,
  t,
}: Readonly<{ goal: CommunityGoal; language: Language; t: Translate }>) {
  const percent = percentOf(goal.progress, goal.target);
  return (
    <>
      <p className={styles.goalTitle} dir="auto">
        {textFor(goal.title, language)}
      </p>
      <div
        className={styles.goalTrack}
        role="progressbar"
        aria-label={textFor(goal.title, language)}
        aria-valuemin={0}
        aria-valuemax={goal.target}
        aria-valuenow={Math.min(goal.progress, goal.target)}
      >
        <div className={styles.goalFill} style={{ inlineSize: `${percent}%` }} />
        {goal.steps
          .filter((step) => !step.isGoal)
          .map((step) => (
            <span
              key={step.threshold}
              className={styles.goalMark}
              style={{ insetInlineStart: `${percentOf(step.threshold, goal.target)}%` }}
            />
          ))}
      </div>
      <p className={styles.goalNumbers}>
        <span>
          {t("community.progress", {
            progress: formatNumber(Math.min(goal.progress, goal.target), language),
            target: formatNumber(goal.target, language),
          })}
        </span>
        <span>{formatNumber(percent, language)}%</span>
      </p>
      {goal.status === "reached" ? (
        <p className={styles.goalReached}>{t("community.reached")}</p>
      ) : null}
      {goal.status === "missed" ? (
        <p className={styles.muted}>{t("screen.community.missed")}</p>
      ) : null}
    </>
  );
}
