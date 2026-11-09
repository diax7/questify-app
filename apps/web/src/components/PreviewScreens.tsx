import { DEFAULT_THEME, themeWithAccent, type Language, type PlayerTab } from "@questify/shared";
import type { ReactNode } from "react";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/preview.module.css";
import { directionOf } from "#src/lib/language.ts";
import {
  phoneTranslator,
  type EventPreview,
  type PreviewQuest,
  type PreviewRankRow,
  type PreviewReward,
} from "#src/lib/preview.ts";
import { themeVariables } from "#src/lib/theme.ts";

type ScreenProps = Readonly<{ preview: EventPreview; language: Language }>;

/** What the phone shows, not the dashboard's own words: the event's renamed labels and its words, filled in (`phoneTranslator`). */
function usePhoneTranslator(preview: EventPreview, language: Language) {
  return phoneTranslator(language, useEventTerms(), preview.texts);
}

/** One screen in its frame, with the event bar under it and the tab the screen belongs to marked. */
function Phone({
  title,
  active,
  preview,
  language,
  children,
}: ScreenProps &
  Readonly<{
    title: string;
    active: PlayerTab;
    children: ReactNode;
  }>) {
  const t = usePhoneTranslator(preview, language);
  return (
    <section
      className={styles.phone}
      aria-label={title}
      dir={directionOf(language)}
      lang={language}
    >
      <div className={styles.screen}>{children}</div>
      <div className={styles.bar} role="list" aria-label={t("layout.bar")}>
        {preview.tabs.map(({ tab, title: tabTitle }) => (
          <span
            role="listitem"
            key={tab}
            className={tab === active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          >
            {t(tabTitle)}
          </span>
        ))}
      </div>
    </section>
  );
}

function Home({ preview, language }: ScreenProps) {
  const t = usePhoneTranslator(preview, language);
  return (
    <Phone title={t("nav.home")} active="index" preview={preview} language={language}>
      <h2 className={styles.screenTitle}>{preview.name}</h2>
      {preview.venue === "" ? null : <p className={styles.muted}>{preview.venue}</p>}
      <ul className={styles.lines} aria-label={t("layout.home")}>
        {preview.homeBlocks.map(({ block, title, lines }) => {
          const [first, ...rest] = lines;
          const more = title === null ? rest : lines;
          return (
            <li key={block} className={styles.line}>
              <span>{title === null ? first : t(title)}</span>
              {more.length === 0 ? null : <span className={styles.muted}>{more.join(" · ")}</span>}
            </li>
          );
        })}
      </ul>
      <div className={styles.buttons}>
        <span className={styles.button}>{t("nav.scan")}</span>
        {preview.agendaButton ? (
          <span className={`${styles.button} ${styles.buttonQuiet}`}>{t("agenda.link")}</span>
        ) : null}
        {preview.mapsButton ? (
          <span className={`${styles.button} ${styles.buttonQuiet}`}>{t("mapsView.link")}</span>
        ) : null}
      </div>
    </Phone>
  );
}

/** The quests of a category: stacked lines, or two cards a row in the card grid (FR-1833). */
function QuestLines({
  quests,
  grid,
  language,
}: Readonly<{ quests: readonly PreviewQuest[]; grid: boolean; language: Language }>) {
  const t = useTranslator(language);
  return (
    <ul className={grid ? styles.tiles : styles.lines}>
      {quests.map((quest) => (
        <li key={quest.id} className={grid ? styles.tile : styles.line}>
          <span className={grid ? styles.tileTitle : undefined}>{quest.title}</span>
          <span className={styles.muted}>{t("quests.pointsShort", { points: quest.points })}</span>
        </li>
      ))}
    </ul>
  );
}

function Quests({ preview, language }: ScreenProps) {
  const t = usePhoneTranslator(preview, language);
  return (
    <Phone title={t("nav.quests")} active="quests" preview={preview} language={language}>
      <h2 className={styles.screenTitle}>{t("nav.quests")}</h2>
      {preview.mapToggle ? (
        <div className={styles.buttons}>
          <span className={styles.button}>{t("mapsView.toggleList")}</span>
          <span className={`${styles.button} ${styles.buttonQuiet}`}>
            {t("mapsView.toggleMap")}
          </span>
        </div>
      ) : null}
      {preview.categories.length === 0 ? (
        <p className={styles.muted}>{t("preview.noQuests")}</p>
      ) : (
        preview.categories.map((category) => (
          <div key={category.id}>
            <h3 className={styles.group}>{category.name}</h3>
            <QuestLines
              quests={category.quests}
              grid={preview.looks.quests === "grid"}
              language={language}
            />
          </div>
        ))
      )}
    </Phone>
  );
}

/** The rewards: stacked lines, or two cards a row in the grid (FR-1833). */
function RewardLines({
  rewards,
  grid,
  language,
}: Readonly<{ rewards: readonly PreviewReward[]; grid: boolean; language: Language }>) {
  const t = useTranslator(language);
  return (
    <ul className={grid ? styles.tiles : styles.lines}>
      {rewards.map((reward) => (
        <li key={reward.id} className={grid ? styles.tile : styles.line}>
          <span>
            <span className={grid ? styles.tileTitle : undefined}>{reward.name}</span>
            <span className={styles.muted}>
              {grid ? " " : " · "}
              {t("quests.pointsShort", { points: reward.price })}
            </span>
          </span>
          <span className={styles.chip}>{t("shop.reserve")}</span>
        </li>
      ))}
    </ul>
  );
}

function Shop({ preview, language }: ScreenProps) {
  const t = usePhoneTranslator(preview, language);
  if (preview.rewards === null) {
    return null;
  }
  return (
    <Phone title={t("nav.rewards")} active="rewards" preview={preview} language={language}>
      <h2 className={styles.screenTitle}>{t("nav.rewards")}</h2>
      {preview.rewards.length === 0 ? (
        <p className={styles.muted}>{t("preview.noRewards")}</p>
      ) : (
        <RewardLines
          rewards={preview.rewards}
          grid={preview.looks.shop === "grid"}
          language={language}
        />
      )}
    </Phone>
  );
}

const STEPS = ["stepSilver", "stepGold", "stepBronze"] as const;
const STEP_HEIGHTS = ["2.6rem", "3.6rem", "2rem"] as const;

/** The top three on a podium, second place on one side of first and third on the other (FR-1832). */
function PodiumRows({
  rows,
  scores,
  language,
}: Readonly<{ rows: readonly PreviewRankRow[]; scores: boolean; language: Language }>) {
  const t = useTranslator(language);
  const places = [rows[1], rows[0], rows[2]];
  return (
    <div className={styles.podium} role="group" aria-label={t("looks.podium")}>
      {places.map((row, index) =>
        row === undefined ? (
          <span key={STEPS[index]} className={styles.place} />
        ) : (
          <span key={row.rank} className={styles.place}>
            <span className={styles.face} aria-hidden="true" />
            <bdi className={styles.placeName}>@{row.username}</bdi>
            {scores ? <span className={styles.muted}>{row.score}</span> : null}
            <span
              className={`${styles.step} ${styles[STEPS[index] ?? "stepGold"]}`}
              style={{ blockSize: STEP_HEIGHTS[index] ?? "2rem" }}
            >
              {row.rank}
            </span>
          </span>
        ),
      )}
    </div>
  );
}

function Ranking({ preview, language }: ScreenProps) {
  const t = usePhoneTranslator(preview, language);
  if (preview.ranking === null) {
    return null;
  }
  const { layout, scores } = preview.looks.ranking;
  const podium = layout === "podium";
  const below = podium ? preview.ranking.slice(3) : preview.ranking;
  return (
    <Phone title={t("nav.ranking")} active="index" preview={preview} language={language}>
      <div className={styles.titleRow}>
        <h2 className={styles.screenTitle}>{t("nav.ranking")}</h2>
        <span className={styles.sample}>{t("looks.sample")}</span>
      </div>
      {podium ? (
        <PodiumRows
          rows={preview.ranking.slice(0, 3)}
          scores={scores === "shown"}
          language={language}
        />
      ) : null}
      <ul className={styles.lines}>
        {below.map((row) => (
          <li key={row.rank} className={styles.line}>
            <span>
              <span className={styles.rankNumber}>{row.rank}</span>
              <bdi>@{row.username}</bdi>
            </span>
            {scores === "shown" ? <span className={styles.muted}>{row.score}</span> : null}
          </li>
        ))}
      </ul>
    </Phone>
  );
}

/** The event info page, its sections in the layout's order (T-613). */
function Info({ preview, language }: ScreenProps) {
  const t = useTranslator(language);
  return (
    <Phone title={t("eventHome.info")} active="index" preview={preview} language={language}>
      <h2 className={styles.screenTitle}>{t("eventHome.info")}</h2>
      <ul className={styles.lines} aria-label={t("layout.info")}>
        {preview.info.map(({ section, title, lines }) => (
          <li key={section} className={styles.line}>
            <span>{t(title)}</span>
            {lines.length === 0 ? null : <span className={styles.muted}>{lines.join(" · ")}</span>}
          </li>
        ))}
      </ul>
    </Phone>
  );
}

/** The one extra page the organizer added: its title, then one line for each part. */
function ExtraPage({ preview, language }: ScreenProps) {
  const t = useTranslator(language);
  if (preview.page === null) {
    return null;
  }
  return (
    <Phone title={t("layout.block.page")} active="index" preview={preview} language={language}>
      <h2 className={styles.screenTitle}>{preview.page.title}</h2>
      <ul className={styles.lines} aria-label={preview.page.title}>
        {preview.page.lines.map((line, index) => (
          // The lines are plain text with no id and keep their order, so the position is their identity.
          // oxlint-disable-next-line react/no-array-index-key
          <li key={`${index}:${line}`} className={styles.line}>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </Phone>
  );
}

/** The screens the layout page can show beside the editor. */
export type PreviewScreen = "home" | "info" | "page" | "ranking" | "quests" | "rewards";

/**
 * One of the player's screens with its bar, redrawn from the unsaved draft as the organizer arranges it (T-606, T-611): Home,
 * and the ranking, Quests and Rewards screens in their chosen layouts. A screen the event does not have draws nothing.
 */
export function ScreenPreview({
  preview,
  language,
  screen,
}: ScreenProps & Readonly<{ screen: PreviewScreen }>) {
  const look = themeVariables(themeWithAccent(DEFAULT_THEME, preview.accent));
  const props = { preview, language };
  return (
    <div className={styles.phones} style={look}>
      {screen === "home" ? <Home {...props} /> : null}
      {screen === "info" ? <Info {...props} /> : null}
      {screen === "page" ? <ExtraPage {...props} /> : null}
      {screen === "ranking" ? <Ranking {...props} /> : null}
      {screen === "quests" ? <Quests {...props} /> : null}
      {screen === "rewards" ? <Shop {...props} /> : null}
    </div>
  );
}

/**
 * The player's Home, ranking, Quests and Rewards screens for one event in one language (FR-1022): the event's words, its
 * accent, its chosen layouts and only the features that are switched on. The ranking and Rewards screens are not drawn
 * while their feature is off, as the app has none.
 */
export function PreviewScreens({ preview, language }: ScreenProps) {
  const look = themeVariables(themeWithAccent(DEFAULT_THEME, preview.accent));
  return (
    <div className={styles.phones} style={look}>
      <Home preview={preview} language={language} />
      <Info preview={preview} language={language} />
      <ExtraPage preview={preview} language={language} />
      <Ranking preview={preview} language={language} />
      <Quests preview={preview} language={language} />
      <Shop preview={preview} language={language} />
    </div>
  );
}
