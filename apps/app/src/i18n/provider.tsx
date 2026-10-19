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
  MESSAGES,
  NO_OVERRIDES,
  createTranslator,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { decideBoot, isRtl } from "#src/i18n/language.ts";
import {
  applyDirectionForNextLaunch,
  deviceLocales,
  layoutIsRtl,
  restartApp,
} from "#src/i18n/native.ts";
import { loadStoredLanguage, saveLanguage } from "#src/i18n/preference.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

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
    void (async () => {
      const stored = await loadStoredLanguage(AsyncStorage);
      const decision = decideBoot({ stored, device: deviceLocales(), layoutIsRtl: layoutIsRtl() });
      if (decision.needsRestart) {
        applyDirectionForNextLaunch(decision.language);
        await restartApp();
        return;
      }
      if (active) {
        setLanguage(decision.language);
        onReady?.();
      }
    })();
    return () => {
      active = false;
    };
  }, [onReady]);

  const switchLanguage = useCallback(async (next: Language) => {
    await saveLanguage(AsyncStorage, next);
    applyDirectionForNextLaunch(next);
    await restartApp();
  }, []);

  const value = useMemo<I18n | null>(() => {
    if (language === null) {
      return null;
    }
    const translate = createTranslator(MESSAGES, NO_OVERRIDES);
    return {
      language,
      rtl: isRtl(language),
      t: (key, params) => translate(key, language, params),
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
