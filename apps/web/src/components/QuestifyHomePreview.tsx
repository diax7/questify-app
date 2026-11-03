import {
  DEFAULT_THEME,
  composedQuestifyHomeOf,
  type BannerSlide,
  type Language,
  type QuestifyHome,
} from "@questify/shared";
import styles from "#src/components/preview.module.css";
import face from "#src/components/questify-home.module.css";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { pickText } from "#src/lib/home-content-editor.ts";
import { themeVariables } from "#src/lib/theme.ts";

/** The banner as the phone draws it: the first slide in the accent colour and a dot for each slide; a hint while it has none. */
function BannerFace({
  slides,
  language,
}: Readonly<{ slides: readonly BannerSlide[]; language: Language }>) {
  const t = translatorFor(language);
  const [first] = slides;
  if (first === undefined) {
    return <div className={face.empty}>{t("console.home.noSlides")}</div>;
  }
  const subtitle = pickText(first.subtitle, language);
  return (
    <div className={face.slide} data-testid="home-preview-slide">
      <p className={face.slideTitle}>{pickText(first.title, language)}</p>
      {subtitle === "" ? null : <p className={face.slideSubtitle}>{subtitle}</p>}
      {slides.length > 1 ? (
        <span className={face.dots} aria-hidden="true">
          {slides.map((_slide, position) => (
            // The slides have no id and keep their order, so the position is their identity.
            // oxlint-disable-next-line react/no-array-index-key
            <span
              key={position}
              className={position === 0 ? `${face.dot} ${face.dotActive}` : face.dot}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The phone beside Questify home's editor (T-713), redrawn from the unsaved draft: the blocks that are shown, in their order,
 * and the banner's first slide. A block that is hidden is not drawn. Nothing in it is a control.
 */
export function QuestifyHomePreview({
  layout,
  language,
}: Readonly<{ layout: QuestifyHome; language: Language }>) {
  const t = translatorFor(language);
  const shown = composedQuestifyHomeOf(layout);
  return (
    <div className={styles.phones} style={themeVariables(DEFAULT_THEME)}>
      <section
        className={styles.phone}
        aria-label={t("console.home.preview")}
        dir={directionOf(language)}
        lang={language}
        data-testid="home-preview"
      >
        <div className={styles.screen}>
          <h3 className={styles.screenTitle}>{t("home.title")}</h3>
          <ul className={styles.lines} aria-label={t("home.title")}>
            {shown.blocks.map((key) => (
              <li key={key} className={styles.line} data-block={key}>
                {key === "banner" ? (
                  <BannerFace slides={shown.banner} language={language} />
                ) : (
                  <span>{t(`questifyHome.block.${key}`)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
