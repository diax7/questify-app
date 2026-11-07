import { formatNumber, shownName, type Language, type NameDisplay } from "@questify/shared";
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
      src={`/avatars/${file}.webp`}
      alt=""
      width={51}
      height={51}
    />
  );
}

/**
 * A player's name on a big-screen board as the event names players (FR-1842): the username, the full name, or both. The
 * scene sends a full name only where the event shows it on the screen and the player was told so; without one the
 * username is drawn, so a row is never empty. The name is typed by the player: `bdi` keeps its direction from reordering
 * the row around it.
 */
export function ScreenName({
  username,
  fullName,
  names,
}: Readonly<{ username: string; fullName: string | null; names: NameDisplay }>) {
  const shown = shownName(fullName, names);
  if (shown.fullName === null) {
    return <>{username}</>;
  }
  return (
    <>
      <bdi>{shown.fullName}</bdi>
      {shown.showUsername ? <bdi dir="ltr">{` @${username}`}</bdi> : null}
    </>
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
