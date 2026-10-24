import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_TERMS,
  MESSAGES,
  NO_OVERRIDES,
  createTranslator,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { decideBoot, isRtl, languageOfLayout } from "#src/i18n/language.ts";
import {
  applyDirectionForNextLaunch,
  deviceLocales,
  layoutIsRtl,
  restartApp,
} from "#src/i18n/native.ts";
import {
  loadRestartNote,
  loadStoredLanguage,
  saveLanguage,
  saveRestartNote,
} from "#src/i18n/preference.ts";
import { withWords, type Translate } from "#src/i18n/words.ts";

type I18n = Readonly<{
  language: Language;
  rtl: boolean;
  t: Translate;
  /** Saves the choice and restarts the app so the layout direction changes everywhere (Q-079). */
  switchLanguage: (next: Language) => Promise<void>;
}>;

const I18nContext = createContext<I18n | null>(null);

/** The language, the translator and the switch. Rendered above everything that shows text. */
export function I18nProvider({
  children,
  onReady,
}: {
  children: ReactNode;
  /** Called once the language is known and no restart is pending, so the splash screen can go. */
  onReady?: () => void;
}) {
  const [language, setLanguage] = useState<Language | null>(null);

  useEffect(() => {
    let active = true;
    const finish = (chosen: Language): void => {
      if (active) {
        setLanguage(chosen);
        onReady?.();
      }
    };
    void (async () => {
      try {
        const decision = decideBoot({
          stored: await loadStoredLanguage(AsyncStorage),
          device: deviceLocales(),
          layoutIsRtl: layoutIsRtl(),
          restartTriedFor: await loadRestartNote(AsyncStorage),
        });
        if (decision.needsRestart) {
          await saveRestartNote(AsyncStorage, decision.language);
          applyDirectionForNextLaunch(decision.language);
          await restartApp();
          return;
        }
        // Keep the note when the phone would not switch, so the next launch does not try (and restart) again.
        if (!decision.fellBack) {
          await saveRestartNote(AsyncStorage, "");
        }
        finish(decision.language);
      } catch {
        // Anything that fails here must not leave the player on the splash screen: carry on in the language that
        // fits the layout the app started with.
        finish(languageOfLayout(layoutIsRtl()));
      }
    })();
    return () => {
      active = false;
    };
  }, [onReady]);

  const switchLanguage = useCallback(async (next: Language) => {
    await saveLanguage(AsyncStorage, next);
    await saveRestartNote(AsyncStorage, next);
    applyDirectionForNextLaunch(next);
    await restartApp();
  }, []);

  const value = useMemo<I18n | null>(() => {
    if (language === null) {
      return null;
    }
    const translate = createTranslator(MESSAGES, NO_OVERRIDES);
    // Outside an event the quest and category words are Questify's own (FR-942); `TermsScope` swaps in an event's.
    return {
      language,
      rtl: isRtl(language),
      t: withWords((key, params) => translate(key, language, params), DEFAULT_TERMS, language),
      switchLanguage,
    };
  }, [language, switchLanguage]);

  if (value === null) {
    return null;
  }
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) {
    throw new Error("useI18n must be used inside I18nProvider.");
  }
  return value;
}

/**
 * Inside an event, the translator fills the event's quest and category words (FR-942) into every text that names
 * them, so a screen never passes them and never shows Questify's default by mistake.
 */
export function TermsScope({
  terms,
  children,
}: Readonly<{ terms: EventTerms; children: ReactNode }>) {
  const parent = useI18n();
  const value = useMemo<I18n>(
    () => ({ ...parent, t: withWords(parent.t, terms, parent.language) }),
    [parent, terms],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
