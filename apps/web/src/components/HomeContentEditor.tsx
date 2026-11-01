"use client";

import {
  BANNER_SLIDES_MAX,
  CONTENT_LIMITS,
  QUICK_LINKS_MAX,
  QUICK_LINK_ICONS,
  isCardKey,
  toInstant,
  toLocalInput,
  type BannerSlide,
  type CountdownCard,
  type HomeCard,
  type HomeContent,
  type HomeKey,
  type QuickLink,
  type TextCard,
} from "@questify/shared";
import { EntryList, type EntryNames } from "#src/components/EntryList.tsx";
import {
  ActionPicker,
  EditorSection,
  TextPair,
  type EditorContext,
  type PickOption,
} from "#src/components/HomeContentFields.tsx";
import { PageEditor } from "#src/components/PageEditor.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { emptyLink, emptySlide } from "#src/lib/home-content-editor.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";

type EditorProps<T> = Readonly<{ value: T; onChange: (next: T) => void; context: EditorContext }>;

function SlideEditor({ value, onChange, context }: EditorProps<BannerSlide>) {
  return (
    <>
      <TextPair
        language={context.language}
        field="layout.field.title"
        value={value.title}
        max={CONTENT_LIMITS.slideTitle}
        onChange={(title) => onChange({ ...value, title })}
      />
      <TextPair
        language={context.language}
        field="layout.field.subtitle"
        value={value.subtitle}
        max={CONTENT_LIMITS.slideSubtitle}
        onChange={(subtitle) => onChange({ ...value, subtitle })}
      />
      <ActionPicker
        language={context.language}
        action={value.action}
        allowNone
        quests={context.quests}
        onChange={(action) => onChange({ ...value, action })}
      />
    </>
  );
}

function LinkEditor({ value, onChange, context }: EditorProps<QuickLink>) {
  const t = useTranslator(context.language);
  return (
    <>
      <TextPair
        language={context.language}
        field="layout.field.label"
        value={value.label}
        max={CONTENT_LIMITS.linkLabel}
        onChange={(label) => onChange({ ...value, label })}
      />
      <Field label={t("layout.field.icon")}>
        <Select
          value={value.icon}
          onChange={(event) =>
            onChange({ ...value, icon: event.target.value as QuickLink["icon"] })
          }
        >
          {QUICK_LINK_ICONS.map((icon) => (
            <option key={icon} value={icon}>
              {t(`layout.icon.${icon}`)}
            </option>
          ))}
        </Select>
      </Field>
      <ActionPicker
        language={context.language}
        action={value.action}
        allowNone={false}
        quests={context.quests}
        onChange={(action) => onChange({ ...value, action })}
      />
    </>
  );
}

const SLIDE_NAMES: EntryNames = {
  earlier: "layout.slide.earlier",
  later: "layout.slide.later",
  remove: "layout.slide.remove",
};
const LINK_NAMES: EntryNames = {
  earlier: "layout.link.earlier",
  later: "layout.link.later",
  remove: "layout.link.remove",
};

function FeaturedEditor({ value, onChange, context }: EditorProps<HomeContent["featured"]>) {
  const t = useTranslator(context.language);
  const options: readonly PickOption[] =
    value === null ? [] : value.kind === "quest" ? context.quests : context.rewards;
  return (
    <>
      <Field label={t("layout.field.kind")}>
        <Select
          value={value?.kind ?? ""}
          onChange={(event) => {
            const kind = event.target.value;
            onChange(kind === "quest" || kind === "reward" ? { kind, id: "" } : null);
          }}
        >
          <option value="">{t("layout.featured.none")}</option>
          <option value="quest">{t("layout.featured.quest")}</option>
          <option value="reward">{t("layout.featured.reward")}</option>
        </Select>
      </Field>
      {value === null ? null : (
        <Field label={t("layout.field.item")}>
          <Select
            value={value.id}
            onChange={(event) => onChange({ kind: value.kind, id: event.target.value })}
          >
            <option value="">{t("layout.choose")}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}

function TextCardEditor({ value, onChange, context }: EditorProps<TextCard>) {
  return (
    <>
      <TextPair
        language={context.language}
        field="layout.field.title"
        value={value.title}
        max={CONTENT_LIMITS.cardTitle}
        onChange={(title) => onChange({ ...value, title })}
      />
      <TextPair
        language={context.language}
        field="layout.field.body"
        value={value.body}
        max={CONTENT_LIMITS.cardBody}
        multiline
        onChange={(body) => onChange({ ...value, body })}
      />
    </>
  );
}

/** The moment as the zone's wall clock for a date-time field; empty while the card has none. */
const localOf = (card: CountdownCard, zone: string): string =>
  card.at === "" ? "" : toLocalInput(new Date(card.at), zone);

function CountdownEditor({ value, onChange, context }: EditorProps<CountdownCard>) {
  const t = useTranslator(context.language);
  const changeTime = (typed: string) => {
    try {
      onChange({ ...value, at: typed === "" ? "" : toInstant(typed, context.zone).toISOString() });
    } catch {
      // A half-typed date is not a moment yet; the field keeps what the last whole one was.
    }
  };
  return (
    <>
      <TextPair
        language={context.language}
        field="layout.field.label"
        value={value.label}
        max={CONTENT_LIMITS.countdownLabel}
        onChange={(label) => onChange({ ...value, label })}
      />
      <Field label={t("layout.field.at", { zone: context.zone })}>
        <Input
          type="datetime-local"
          value={localOf(value, context.zone)}
          onChange={(event) => changeTime(event.target.value)}
        />
      </Field>
      <Field label={t("layout.field.atZero")}>
        <Select
          value={value.atZero}
          onChange={(event) =>
            onChange({ ...value, atZero: event.target.value === "message" ? "message" : "hide" })
          }
        >
          <option value="hide">{t("layout.atZero.hide")}</option>
          <option value="message">{t("layout.atZero.message")}</option>
        </Select>
      </Field>
      {value.atZero === "message" ? (
        <TextPair
          language={context.language}
          field="layout.field.message"
          value={value.message}
          max={CONTENT_LIMITS.countdownMessage}
          onChange={(message) => onChange({ ...value, message })}
        />
      ) : null}
    </>
  );
}

function CardEditor({
  cardId,
  content,
  onChange,
  context,
}: Readonly<{
  cardId: string;
  content: HomeContent;
  onChange: (next: HomeContent) => void;
  context: EditorContext;
}>) {
  const card = content.cards.find((entry) => entry.id === cardId);
  if (card === undefined) {
    return null;
  }
  const replace = (next: HomeCard) =>
    onChange({
      ...content,
      cards: content.cards.map((entry) => (entry.id === cardId ? next : entry)),
    });
  return card.kind === "text" ? (
    <TextCardEditor value={card} onChange={replace} context={context} />
  ) : (
    <CountdownEditor value={card} onChange={replace} context={context} />
  );
}

/**
 * The editor of one Home block that holds the organizer's own words (FR-1828 to FR-1830, FR-1835): the banner's slides, the quick
 * links, the featured item, one card, or the extra page. It edits the page's draft, so the preview redraws as the organizer
 * types, and nothing is saved until Save layout.
 */
export function HomeContentEditor({
  blockKey,
  title,
  content,
  context,
  onChange,
  onRemovePage,
  onClose,
}: Readonly<{
  blockKey: HomeKey;
  title: string;
  content: HomeContent;
  context: EditorContext;
  onChange: (next: HomeContent) => void;
  onRemovePage: () => void;
  onClose: () => void;
}>) {
  const t = useTranslator(context.language);
  const { language } = context;
  return (
    <EditorSection language={language} title={title} onClose={onClose}>
      {blockKey === "banner" ? (
        <EntryList
          language={language}
          entries={content.banner}
          limit={BANNER_SLIDES_MAX}
          heading={(_slide, n) => t("layout.slide", { n })}
          names={SLIDE_NAMES}
          footer={
            <Button
              variant="secondary"
              onClick={() => onChange({ ...content, banner: [...content.banner, emptySlide()] })}
            >
              {t("layout.slide.add")}
            </Button>
          }
          onChange={(banner) => onChange({ ...content, banner })}
        >
          {(slide, replace) => <SlideEditor value={slide} onChange={replace} context={context} />}
        </EntryList>
      ) : null}
      {blockKey === "quickLinks" ? (
        <EntryList
          language={language}
          entries={content.quickLinks}
          limit={QUICK_LINKS_MAX}
          heading={(_link, n) => t("layout.link", { n })}
          names={LINK_NAMES}
          footer={
            <Button
              variant="secondary"
              onClick={() =>
                onChange({ ...content, quickLinks: [...content.quickLinks, emptyLink()] })
              }
            >
              {t("layout.link.add")}
            </Button>
          }
          onChange={(quickLinks) => onChange({ ...content, quickLinks })}
        >
          {(link, replace) => <LinkEditor value={link} onChange={replace} context={context} />}
        </EntryList>
      ) : null}
      {blockKey === "featured" ? (
        <FeaturedEditor
          value={content.featured}
          onChange={(featured) => onChange({ ...content, featured })}
          context={context}
        />
      ) : null}
      {blockKey === "page" ? (
        <PageEditor
          language={language}
          page={content.page}
          onChange={(page) => onChange({ ...content, page })}
          onRemove={onRemovePage}
        />
      ) : null}
      {isCardKey(blockKey) ? (
        <CardEditor
          cardId={blockKey.slice("card:".length)}
          content={content}
          onChange={onChange}
          context={context}
        />
      ) : null}
    </EditorSection>
  );
}
