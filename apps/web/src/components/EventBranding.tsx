"use client";

import {
  ACCENTS,
  ACCENT_KEYS,
  DEFAULT_THEME,
  type AccentKey,
  type Language,
} from "@questify/shared";
import { useState } from "react";
import { ImageField } from "#src/components/ImageField.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Notice, Swatch } from "#src/ui/Feedback.tsx";
import { FieldGroup, Radio } from "#src/ui/Field.tsx";
import { Section } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/**
 * The event's look (FR-1023): one accent colour from the curated list, or Questify green. It colours the buttons of the
 * event's screens; the wood, parchment, fonts and the rest of the brand stay. Saved as soon as a colour is picked, by an
 * owner or an editor. There is no free colour, font or theme to pick.
 */
type Look = Readonly<{ accent: AccentKey | null; logo: string | null; banner: string | null }>;

export function EventBranding({
  language,
  organizerId,
  eventId,
  initial,
  initialLogo = null,
  initialBanner = null,
}: Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  initial: AccentKey | null;
  /** The event's logo and banner image ids (T-602b), shown and changed only on a server with a bucket. */
  initialLogo?: string | null;
  initialBanner?: string | null;
}>) {
  const t = useTranslator(language);
  const [look, setLook] = useState<Look>({
    accent: initial,
    logo: initialLogo,
    banner: initialBanner,
  });
  const accent = look.accent;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (patch: Partial<Look>) => {
    if (busy) return;
    const before = look;
    const next = { ...look, ...patch };
    setLook(next);
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/branding`,
      next,
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    if (!result.ok) {
      setLook(before);
      setProblem(describeProblem(result.body, language, t).text);
    }
  };

  const choices: readonly Readonly<{ key: AccentKey | null; hex: string; name: string }>[] = [
    { key: null, hex: DEFAULT_THEME.colors.primaryAction, name: t("branding.accent.default") },
    ...ACCENT_KEYS.map((key) => ({
      key,
      hex: ACCENTS[key].hex,
      name: t(ACCENTS[key].label),
    })),
  ];

  return (
    <Section title={t("branding.title")}>
      <FieldGroup legend={t("branding.accent")} layout="choiceGrid">
        {choices.map((choice) => (
          <Radio
            key={choice.key ?? "default"}
            name="accent"
            checked={accent === choice.key}
            aria-busy={busy}
            onChange={() => void save({ accent: choice.key })}
            label={
              <>
                <Swatch color={choice.hex} />
                {choice.name}
              </>
            }
          />
        ))}
      </FieldGroup>
      <ImageField
        language={language}
        purpose="logo"
        label={t("image.logo")}
        value={look.logo}
        disabled={busy}
        onChange={(logo) => void save({ logo })}
      />
      <ImageField
        language={language}
        purpose="banner"
        label={t("image.banner")}
        value={look.banner}
        disabled={busy}
        onChange={(banner) => void save({ banner })}
      />
      {problem === null ? null : (
        <Notice role="alert" tone="danger">
          {problem}
        </Notice>
      )}
    </Section>
  );
}
