"use client";

import {
  ACCENTS,
  ACCENT_KEYS,
  DEFAULT_THEME,
  type AccentKey,
  type Language,
} from "@questify/shared";
import { useState } from "react";
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
export function EventBranding({
  language,
  organizerId,
  eventId,
  initial,
}: Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  initial: AccentKey | null;
}>) {
  const t = useTranslator(language);
  const [accent, setAccent] = useState<AccentKey | null>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (next: AccentKey | null) => {
    const before = accent;
    setAccent(next);
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/branding`,
      { accent: next },
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    if (!result.ok) {
      setAccent(before);
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
      <FieldGroup legend={t("branding.accent")} layout="choiceGrid" disabled={busy}>
        {choices.map((choice) => (
          <Radio
            key={choice.key ?? "default"}
            name="accent"
            checked={accent === choice.key}
            onChange={() => void save(choice.key)}
            label={
              <>
                <Swatch color={choice.hex} />
                {choice.name}
              </>
            }
          />
        ))}
      </FieldGroup>
      {problem === null ? null : (
        <Notice role="alert" tone="danger">
          {problem}
        </Notice>
      )}
    </Section>
  );
}
