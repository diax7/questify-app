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
import type { ReactNode } from "react";
import {
  ActionPicker,
  TextPair,
  type EditorContext,
  type PickOption,
} from "#src/components/HomeContentFields.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { emptyLink, emptySlide, moveWithin } from "#src/lib/home-content-editor.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Card, Section, SubHeading, Toolbar } from "#src/ui/Section.tsx";

type EditorProps<T> = Readonly<{ value: T; onChange: (next: T) => void; context: EditorContext }>;

/** Move earlier, move later and remove, for one entry of a list (a slide, a link). */
function EntryTools({
  context,
  names,
  n,
  last,
  onMove,
  onRemove,
}: Readonly<{
  context: EditorContext;
  names: Readonly<{
    earlier: "layout.slide.earlier" | "layout.link.earlier";
    later: "layout.slide.later" | "layout.link.later";
    remove: "layout.slide.remove" | "layout.link.remove";
  }>;
  n: number;
  last: boolean;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
}>) {
  const t = useTranslator(context.language);
  return (
    <Toolbar>
      <IconButton
        icon="arrowUp"
        label={t(names.earlier, { n })}
        disabled={n === 1}
        onClick={() => onMove(-1)}
      />
      <IconButton
        icon="arrowDown"
        label={t(names.later, { n })}
        disabled={last}
        onClick={() => onMove(1)}
      />
      <IconButton icon="trash" label={t(names.remove, { n })} onClick={onRemove} />
    </Toolbar>
  );
}

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

/** A list of entries with the same editor each, up to a limit, with add, move and remove. */
function EntryList<T>({
  context,
  entries,
  limit,
  title,
  names,
  addLabel,
  make,
  onChange,
  children,
}: Readonly<{
  context: EditorContext;
  entries: readonly T[];
  limit: number;
  title: "layout.slide" | "layout.link";
  names: Parameters<typeof EntryTools>[0]["names"];
  addLabel: "layout.slide.add" | "layout.link.add";
  make: () => T;
  onChange: (next: T[]) => void;
  children: (entry: T, replace: (next: T) => void) => ReactNode;
}>) {
  const t = useTranslator(context.language);
  return (
    <>
      {entries.map((entry, index) => (
        // The entries have no id and keep their order, so the position is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        <Card key={index} as="section" aria-label={t(title, { n: index + 1 })}>
          <SubHeading>{t(title, { n: index + 1 })}</SubHeading>
          {children(entry, (next) =>
            onChange(entries.map((item, position) => (position === index ? next : item))),
          )}
          <EntryTools
            context={context}
            names={names}
            n={index + 1}
            last={index === entries.length - 1}
            onMove={(step) => onChange(moveWithin(entries, index, step))}
            onRemove={() => onChange(entries.filter((_item, position) => position !== index))}
          />
        </Card>
      ))}
      {entries.length < limit ? (
        <Toolbar>
          <Button variant="secondary" onClick={() => onChange([...entries, make()])}>
            {t(addLabel)}
          </Button>
        </Toolbar>
      ) : null}
    </>
  );
}

const SLIDE_NAMES = {
  earlier: "layout.slide.earlier",
  later: "layout.slide.later",
  remove: "layout.slide.remove",
} as const;
const LINK_NAMES = {
  earlier: "layout.link.earlier",
  later: "layout.link.later",
  remove: "layout.link.remove",
} as const;

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
 * The editor of one Home block that holds the organizer's own words (FR-1828 to FR-1830): the banner's slides, the quick
 * links, the featured item, or one card. It edits the page's draft, so the preview redraws as the organizer types, and nothing
 * is saved until Save layout.
 */
export function HomeContentEditor({
  blockKey,
  title,
  content,
  context,
  onChange,
  onClose,
}: Readonly<{
  blockKey: HomeKey;
  title: string;
  content: HomeContent;
  context: EditorContext;
  onChange: (next: HomeContent) => void;
  onClose: () => void;
}>) {
  const t = useTranslator(context.language);
  return (
    <Section
      title={t("layout.editing", { item: title })}
      actions={
        <Button variant="quiet" onClick={onClose}>
          {t("layout.closeEditor")}
        </Button>
      }
    >
      {blockKey === "banner" ? (
        <EntryList
          context={context}
          entries={content.banner}
          limit={BANNER_SLIDES_MAX}
          title="layout.slide"
          names={SLIDE_NAMES}
          addLabel="layout.slide.add"
          make={emptySlide}
          onChange={(banner) => onChange({ ...content, banner })}
        >
          {(slide, replace) => <SlideEditor value={slide} onChange={replace} context={context} />}
        </EntryList>
      ) : null}
      {blockKey === "quickLinks" ? (
        <EntryList
          context={context}
          entries={content.quickLinks}
          limit={QUICK_LINKS_MAX}
          title="layout.link"
          names={LINK_NAMES}
          addLabel="layout.link.add"
          make={emptyLink}
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
      {isCardKey(blockKey) ? (
        <CardEditor
          cardId={blockKey.slice("card:".length)}
          content={content}
          onChange={onChange}
          context={context}
        />
      ) : null}
    </Section>
  );
}
