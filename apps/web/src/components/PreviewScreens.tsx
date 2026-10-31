import { DEFAULT_THEME, themeWithAccent, type Language, type PlayerTab } from "@questify/shared";
import type { ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/preview.module.css";
import { directionOf } from "#src/lib/language.ts";
import type { EventPreview } from "#src/lib/preview.ts";
import { themeVariables } from "#src/lib/theme.ts";

type ScreenProps = Readonly<{ preview: EventPreview; language: Language }>;

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
  const t = useTranslator(language);
  return (
    <section
      className={styles.phone}
      aria-label={title}
      dir={directionOf(language)}
      lang={language}
    >
      <div className={styles.screen}>{children}</div>
      <div className={styles.bar}>
        {preview.tabs.map(({ tab, title: tabTitle }) => (
          <span
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
  const t = useTranslator(language);
  return (
    <Phone title={t("nav.home")} active="index" preview={preview} language={language}>
      <h3 className={styles.screenTitle}>{preview.name}</h3>
      {preview.venue === "" ? null : <p className={styles.muted}>{preview.venue}</p>}
      {preview.rankingCard ? (
        <ul className={styles.lines}>
          <li className={styles.line}>{t("nav.ranking")}</li>
        </ul>
      ) : null}
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

function Quests({ preview, language }: ScreenProps) {
  const t = useTranslator(language);
  return (
    <Phone title={t("nav.quests")} active="quests" preview={preview} language={language}>
      <h3 className={styles.screenTitle}>{t("nav.quests")}</h3>
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
            <h4 className={styles.group}>{category.name}</h4>
            <ul className={styles.lines}>
              {category.quests.map((quest) => (
                <li key={quest.id} className={styles.line}>
                  <span>{quest.title}</span>
                  <span className={styles.muted}>
                    {t("quests.pointsShort", { points: quest.points })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </Phone>
  );
}

function Shop({ preview, language }: ScreenProps) {
  const t = useTranslator(language);
  if (preview.rewards === null) {
    return null;
  }
  return (
    <Phone title={t("nav.rewards")} active="rewards" preview={preview} language={language}>
      <h3 className={styles.screenTitle}>{t("nav.rewards")}</h3>
      {preview.rewards.length === 0 ? (
        <p className={styles.muted}>{t("preview.noRewards")}</p>
      ) : (
        <ul className={styles.lines}>
          {preview.rewards.map((reward) => (
            <li key={reward.id} className={styles.line}>
              <span>
                {reward.name}
                <span className={styles.muted}>
                  {" · "}
                  {t("quests.pointsShort", { points: reward.price })}
                </span>
              </span>
              <span className={styles.chip}>{t("shop.reserve")}</span>
            </li>
          ))}
        </ul>
      )}
    </Phone>
  );
}

/**
 * The player's Home, Quests and Rewards screens for one event in one language (FR-1022): the event's words, its accent
 * and only the features that are switched on. The Rewards screen is not drawn while the shop is off, as the app has none.
 */
export function PreviewScreens({ preview, language }: ScreenProps) {
  const look = themeVariables(themeWithAccent(DEFAULT_THEME, preview.accent));
  return (
    <div className={styles.phones} style={look}>
      <Home preview={preview} language={language} />
      <Quests preview={preview} language={language} />
      <Shop preview={preview} language={language} />
    </div>
  );
}
