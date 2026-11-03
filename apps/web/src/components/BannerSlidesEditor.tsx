"use client";

import {
  BANNER_SLIDES_MAX,
  CONTENT_LIMITS,
  type BannerSlide,
  type Language,
} from "@questify/shared";
import { EntryList, type EntryNames } from "#src/components/EntryList.tsx";
import {
  ActionPicker,
  TextPair,
  type ActionKind,
  type PickOption,
} from "#src/components/HomeContentFields.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { emptySlide } from "#src/lib/home-content-editor.ts";
import { Button } from "#src/ui/Button.tsx";

const SLIDE_NAMES: EntryNames = {
  earlier: "layout.slide.earlier",
  later: "layout.slide.later",
  remove: "layout.slide.remove",
};

function SlideEditor({
  language,
  value,
  quests,
  kinds,
  onChange,
}: Readonly<{
  language: Language;
  value: BannerSlide;
  quests: readonly PickOption[];
  kinds: readonly ActionKind[] | undefined;
  onChange: (next: BannerSlide) => void;
}>) {
  return (
    <>
      <TextPair
        language={language}
        field="layout.field.title"
        value={value.title}
        max={CONTENT_LIMITS.slideTitle}
        onChange={(title) => onChange({ ...value, title })}
      />
      <TextPair
        language={language}
        field="layout.field.subtitle"
        value={value.subtitle}
        max={CONTENT_LIMITS.slideSubtitle}
        onChange={(subtitle) => onChange({ ...value, subtitle })}
      />
      <ActionPicker
        language={language}
        action={value.action}
        allowNone
        quests={quests}
        kinds={kinds}
        onChange={(action) => onChange({ ...value, action })}
      />
    </>
  );
}

/**
 * The banner's slides (FR-1829, T-610, T-713): up to five, each with a title and a subtitle in both languages and a tap, with
 * move and remove on every slide. An event's banner can open its screens, a quest or a link; Questify home's (`kinds`) opens
 * nothing or a web link.
 */
export function BannerSlidesEditor({
  language,
  slides,
  quests,
  kinds,
  onChange,
}: Readonly<{
  language: Language;
  slides: readonly BannerSlide[];
  quests: readonly PickOption[];
  /** The taps a slide may have; every kind while undefined. */
  kinds?: readonly ActionKind[] | undefined;
  onChange: (next: BannerSlide[]) => void;
}>) {
  const t = useTranslator(language);
  return (
    <EntryList
      language={language}
      entries={slides}
      limit={BANNER_SLIDES_MAX}
      heading={(_slide, n) => t("layout.slide", { n })}
      names={SLIDE_NAMES}
      footer={
        <Button variant="secondary" onClick={() => onChange([...slides, emptySlide()])}>
          {t("layout.slide.add")}
        </Button>
      }
      onChange={onChange}
    >
      {(slide, replace) => (
        <SlideEditor
          language={language}
          value={slide}
          quests={quests}
          kinds={kinds}
          onChange={replace}
        />
      )}
    </EntryList>
  );
}
