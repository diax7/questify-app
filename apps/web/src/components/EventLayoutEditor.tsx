"use client";

import {
  BAR_PROTECTED,
  HOME_BLOCKS,
  HOME_CARDS_MAX,
  HOME_PROTECTED,
  INFO_PROTECTED,
  INFO_SECTIONS,
  LAYOUT_PRESETS,
  PLAYER_TABS,
  applyPreset,
  cardKey,
  homeBlocks,
  homeKeysOf,
  infoSections,
  matchingPreset,
  playerTabs,
  presetLayout,
  readEventLayout,
  sameLayout,
  type EventLayout,
  type HomeContent,
  type HomeKey,
  type InfoSection,
  type Language,
  type MessageKey,
  type PlayerTab,
} from "@questify/shared";
import { useMemo, useState } from "react";
import { HomeContentEditor } from "#src/components/HomeContentEditor.tsx";
import type { EditorContext, PickOption } from "#src/components/HomeContentFields.tsx";
import { InfoContentEditor } from "#src/components/InfoContentEditor.tsx";
import { ItemList, type LayoutItem } from "#src/components/LayoutItemList.tsx";
import { LayoutPreviewPane } from "#src/components/LayoutPreviewPane.tsx";
import type { PreviewScreen } from "#src/components/PreviewScreens.tsx";
import { ScreenStyles } from "#src/components/ScreenStyles.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import styles from "#src/components/layout-editor.module.css";
import {
  addCard,
  canAddCard,
  contentProblem,
  homeLabel,
  newCardId,
  newCountdownCard,
  newTextCard,
  removeCard,
} from "#src/lib/home-content-editor.ts";
import { featureLookup, previewOf } from "#src/lib/preview.ts";
import { usePreview, type PreviewSource } from "#src/lib/use-preview.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice, ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import { FieldGroup, Radio } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Section, Stack, Toolbar } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Ids = Readonly<{ language: Language; organizerId: string; eventId: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const bodyOf = (layout: EventLayout) => ({
  bar: layout.bar,
  home: layout.home,
  info: layout.info,
  content: layout.content,
  looks: layout.looks,
});

/** The name of an item the API refused to hide, in either list. */
function protectedName(item: unknown, t: (key: MessageKey) => string): string | undefined {
  const key =
    PLAYER_TABS.find((entry) => entry.tab === item)?.title ??
    HOME_BLOCKS.find((entry) => entry.block === item)?.title ??
    INFO_SECTIONS.find((entry) => entry.section === item)?.title;
  return key === undefined ? undefined : t(key);
}

/** What to tell the organizer about a refused save, naming the protected item the server refused to hide. */
function refusalText(
  body: unknown,
  language: Language,
  t: ReturnType<typeof useTranslator>,
): string {
  const details = isRecord(body) ? body["details"] : undefined;
  const named = isRecord(details) ? protectedName(details["item"], t) : undefined;
  return errorCodeOf(body) === "layout_item_protected" && named !== undefined
    ? t("layout.protectedNamed", { item: named })
    : describeProblem(body, language, t).text;
}

/**
 * Saves a layout (a preset by name, or the lists) and says what went wrong in words. Returns the layout the API stored,
 * or null when it refused.
 */
function useLayoutSave({ language, organizerId, eventId }: Ids) {
  const t = useTranslator(language);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (body: unknown): Promise<EventLayout | null> => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "PUT",
      `/v1/organizers/${organizerId}/events/${eventId}/layout`,
      body,
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return null;
    }
    if (result.ok && isRecord(result.body)) {
      return readEventLayout(result.body["layout"]);
    }
    setProblem(refusalText(result.body, language, t));
    return null;
  };
  return { busy, problem, save, clearProblem: () => setProblem(null) };
}

function barItems(
  t: (key: MessageKey) => string,
  on: (feature: string) => boolean,
): readonly LayoutItem<PlayerTab>[] {
  return PLAYER_TABS.map((entry) => ({
    key: entry.tab,
    label: t(entry.title),
    isProtected: BAR_PROTECTED.has(entry.tab),
    switchedOff: playerTabs(on, [entry.tab]).length === 0,
  }));
}

/** The blocks that hold words or links the organizer writes: each gets an Edit button. */
const EDITABLE_BLOCKS: ReadonlySet<HomeKey> = new Set(["banner", "quickLinks", "featured", "page"]);

/** The info page's sections that hold words the organizer writes: each gets an Edit button. */
const EDITABLE_SECTIONS: ReadonlySet<InfoSection> = new Set(["about", "faq", "contacts"]);

function infoItems(
  t: (key: MessageKey) => string,
  on: (feature: string) => boolean,
): readonly LayoutItem<InfoSection>[] {
  return INFO_SECTIONS.map((entry) => ({
    key: entry.section,
    label: t(entry.title),
    isProtected: INFO_PROTECTED.has(entry.section),
    switchedOff: infoSections(on, [entry.section]).length === 0,
    editable: EDITABLE_SECTIONS.has(entry.section),
  }));
}

function homeItems(
  t: (key: MessageKey) => string,
  on: (feature: string) => boolean,
  content: HomeContent,
  language: Language,
): readonly LayoutItem<HomeKey>[] {
  const blocks = HOME_BLOCKS.map((entry) => ({
    key: entry.block as HomeKey,
    label: t(entry.title),
    isProtected: HOME_PROTECTED.has(entry.block),
    switchedOff: homeBlocks(on, [entry.block]).length === 0,
    editable: EDITABLE_BLOCKS.has(entry.block),
  }));
  const cards = content.cards.map((card) => ({
    key: cardKey(card.id) as HomeKey,
    label: homeLabel(cardKey(card.id), content, language, t),
    isProtected: false,
    switchedOff: false,
    editable: true,
    removable: true,
  }));
  return [...blocks, ...cards];
}

function Presets({
  language,
  current,
  disabled,
  onPick,
  onReset,
}: Readonly<{
  language: Language;
  current: string | null;
  disabled: boolean;
  onPick: (id: string) => void;
  onReset: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Section
      title={t("layout.presets")}
      actions={
        <>
          {current === null ? <Badge>{t("layout.custom")}</Badge> : undefined}
          <Button variant="quiet" disabled={disabled} onClick={onReset}>
            {t("layout.reset")}
          </Button>
        </>
      }
    >
      <FieldGroup layout="choiceGrid" disabled={disabled}>
        {LAYOUT_PRESETS.map((preset) => (
          <Radio
            key={preset.id}
            name="layout-preset"
            checked={current === preset.id}
            onChange={() => onPick(preset.id)}
            label={t(preset.title)}
          />
        ))}
      </FieldGroup>
    </Section>
  );
}

/** The draft layout, what was last saved, and the ways to change them: edit, pick a preset, adopt what the server stored. */
function useLayoutDraft(ids: Ids, source: PreviewSource) {
  const start = useMemo(() => readEventLayout(source.event.layout), [source.event.layout]);
  const [saved, setSaved] = useState(start);
  const [draft, setDraft] = useState(start);
  const [done, setDone] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const saving = useLayoutSave(ids);
  const dirty = !sameLayout(saved, draft);

  const adopt = (stored: EventLayout | null) => {
    if (stored !== null) {
      setSaved(stored);
      setDraft(stored);
      setDone(true);
    }
  };
  const edit = (next: EventLayout, spoken?: string) => {
    setDraft(next);
    setDone(false);
    saving.clearProblem();
    if (spoken !== undefined) setAnnouncement(spoken);
  };
  // With nothing unsaved a preset saves in one tap, shown at once and undone if the server refuses. With unsaved changes it
  // only arranges the draft, so a preset never throws away words that were not saved yet.
  const pick = async (id: string): Promise<void> => {
    const chosen = presetLayout(id);
    if (chosen === undefined) return;
    const next = applyPreset(draft, chosen);
    if (dirty) {
      edit(next);
      return;
    }
    const before = draft;
    setDraft(next);
    const stored = await saving.save({ preset: id });
    if (stored === null) setDraft(before);
    else adopt(stored);
  };
  return { saved, draft, dirty, done, announcement, adopt, edit, pick, ...saving };
}

/** What the content editor's pickers offer, from the event's own quests and rewards. */
function editorContext(source: PreviewSource, language: Language): EditorContext {
  const name = (text: Readonly<{ ar: string | null; en: string | null }>): string =>
    text[language] ?? text.en ?? text.ar ?? "";
  const quests: PickOption[] = source.categories
    .flatMap((category) => category.quests)
    .map((quest) => ({ id: quest.id, label: name(quest.title) }));
  const rewards: PickOption[] = source.rewards.map((reward) => ({
    id: reward.id,
    label: name(reward.name),
  }));
  return { language, zone: source.event.timezone, quests, rewards };
}

/** A new countdown starts a day from now, on the hour. */
const tomorrow = (): string =>
  new Date(Math.ceil((Date.now() + 86_400_000) / 3_600_000) * 3_600_000).toISOString();

function AddCards({
  language,
  layout,
  onAdd,
}: Readonly<{
  language: Language;
  layout: EventLayout;
  onAdd: (kind: "text" | "countdown") => void;
}>) {
  const t = useTranslator(language);
  const room = canAddCard(layout);
  return (
    <>
      {room ? null : <Muted>{t("layout.cardsFull", { max: HOME_CARDS_MAX })}</Muted>}
      <Button variant="secondary" disabled={!room} onClick={() => onAdd("text")}>
        {t("layout.addText")}
      </Button>
      <Button variant="secondary" disabled={!room} onClick={() => onAdd("countdown")}>
        {t("layout.addCountdown")}
      </Button>
    </>
  );
}

/** Adding a card, removing one and resetting to the default, the last two after a confirmation. */
function useCardActions(
  language: Language,
  state: ReturnType<typeof useLayoutDraft>,
  setEditing: (update: (open: HomeKey | null) => HomeKey | null) => void,
) {
  const t = useTranslator(language);
  const confirmation = useConfirmation(language);
  const { draft, edit } = state;
  const add = (kind: "text" | "countdown") => {
    const id = newCardId();
    edit(addCard(draft, kind === "text" ? newTextCard(id) : newCountdownCard(id, tomorrow())));
    setEditing(() => cardKey(id));
  };
  const remove = (key: HomeKey) => {
    confirmation.ask({
      title: t("layout.removeTitle"),
      body: t("layout.removeBody"),
      confirmLabel: t("layout.removeConfirm"),
      run: () => {
        edit(removeCard(draft, key.slice("card:".length)));
        setEditing((open) => (open === key ? null : open));
      },
    });
  };
  const removePage = () => {
    confirmation.ask({
      title: t("layout.page.removeTitle"),
      body: t("layout.page.removeBody"),
      confirmLabel: t("layout.removeConfirm"),
      run: () => {
        edit({ ...draft, content: { ...draft.content, page: null } });
        setEditing((open) => (open === "page" ? null : open));
      },
    });
  };
  const reset = () => {
    confirmation.ask({
      title: t("layout.resetTitle"),
      body: t("layout.resetBody"),
      confirmLabel: t("layout.resetConfirm"),
      run: () => state.pick("classic"),
    });
  };
  return { add, remove, removePage, reset, dialog: confirmation.dialog };
}

/** What the page has to say about the draft: unfinished words, a refusal, or that it was saved. */
function SaveNotes({
  language,
  state,
}: Readonly<{ language: Language; state: ReturnType<typeof useLayoutDraft> }>) {
  const t = useTranslator(language);
  const { draft, dirty, problem } = state;
  const unwritten = contentProblem(draft.content);
  return (
    <>
      {unwritten === null || !dirty ? null : (
        <Notice role="status" tone="warning">
          {t(unwritten.key, { n: unwritten.n })}
        </Notice>
      )}
      {problem === null ? null : (
        <Notice role="alert" tone="danger">
          {problem}
        </Notice>
      )}
      {state.done && !dirty ? (
        <Notice role="status" tone="success">
          {t("layout.saved")}
        </Notice>
      ) : null}
    </>
  );
}

/** Save and Discard, then the notes, and the line a screen reader hears after a move. */
function SaveBar({
  language,
  state,
}: Readonly<{ language: Language; state: ReturnType<typeof useLayoutDraft> }>) {
  const t = useTranslator(language);
  const { draft, dirty, busy, save, adopt, edit } = state;
  return (
    <>
      <Toolbar>
        <Button
          variant="primary"
          disabled={!dirty || busy || contentProblem(draft.content) !== null}
          onClick={() => void save(bodyOf(draft)).then(adopt)}
        >
          {t("layout.save")}
        </Button>
        <Button variant="quiet" disabled={!dirty || busy} onClick={() => edit(state.saved)}>
          {t("layout.discard")}
        </Button>
      </Toolbar>
      <SaveNotes language={language} state={state} />
      <ScreenReaderOnly>
        <span role="status" aria-live="polite">
          {state.announcement}
        </span>
      </ScreenReaderOnly>
    </>
  );
}

function Workspace({ source, ...ids }: Ids & Readonly<{ source: PreviewSource }>) {
  const { language } = ids;
  const t = useTranslator(language);
  const state = useLayoutDraft(ids, source);
  const { draft, busy, edit } = state;
  const [editing, setEditing] = useState<HomeKey | null>(null);
  const [editingInfo, setEditingInfo] = useState<InfoSection | null>(null);
  const [screen, setScreen] = useState<PreviewScreen>("home");
  const cards = useCardActions(language, state, setEditing);
  const on = featureLookup(source.event);
  const preview = previewOf(
    { ...source.event, layout: draft },
    source.categories,
    source.rewards,
    language,
  );
  const open = editing !== null && homeKeysOf(draft.content).includes(editing) ? editing : null;

  return (
    <div className={styles.workspace}>
      <div className={styles.editor}>
        <Presets
          language={language}
          current={matchingPreset(draft)?.id ?? null}
          disabled={busy}
          onPick={(id) => void state.pick(id)}
          onReset={cards.reset}
        />
        <ItemList
          language={language}
          title={t("layout.bar")}
          items={barItems(t, on)}
          list={draft.bar}
          protectedKeys={BAR_PROTECTED}
          onChange={(bar, spoken) => edit({ ...draft, bar }, spoken)}
        />
        <ItemList
          language={language}
          title={t("layout.home")}
          items={homeItems(t, on, draft.content, language)}
          list={draft.home}
          protectedKeys={HOME_PROTECTED}
          onChange={(home, spoken) => edit({ ...draft, home }, spoken)}
          actions={<AddCards language={language} layout={draft} onAdd={cards.add} />}
          editing={open}
          onEdit={(key) => setEditing(key === open ? null : key)}
          onRemove={cards.remove}
        />
        {open === null ? null : (
          <HomeContentEditor
            blockKey={open}
            title={homeLabel(open, draft.content, language, t)}
            content={draft.content}
            context={editorContext(source, language)}
            onChange={(content) => edit({ ...draft, content })}
            onRemovePage={cards.removePage}
            onClose={() => setEditing(null)}
          />
        )}
        <ItemList
          language={language}
          title={t("layout.info")}
          items={infoItems(t, on)}
          list={draft.info}
          protectedKeys={INFO_PROTECTED}
          onChange={(info, spoken) => edit({ ...draft, info }, spoken)}
          editing={editingInfo}
          onEdit={(key) => setEditingInfo(key === editingInfo ? null : key)}
        />
        {editingInfo === null ? null : (
          <InfoContentEditor
            language={language}
            section={editingInfo}
            title={t(`layout.info.${editingInfo}.title`)}
            content={draft.content}
            onChange={(content) => edit({ ...draft, content })}
            onClose={() => setEditingInfo(null)}
          />
        )}
        <ScreenStyles
          language={language}
          looks={draft.looks}
          on={on}
          onChange={(looks) => edit({ ...draft, looks })}
          onTouch={setScreen}
        />
        <SaveBar language={language} state={state} />
      </div>
      <div className={styles.preview}>
        <LayoutPreviewPane
          preview={preview}
          language={language}
          screen={screen}
          onScreen={setScreen}
        />
      </div>
      {cards.dialog}
    </div>
  );
}

/**
 * The event's layout (FR-1749, FR-1764, T-606): the approved presets in one tap, then the bottom bar and the Home blocks as
 * two lists to reorder (by dragging or with the move buttons) and to show or hide, with the Home screen redrawn as the
 * organizer arranges it. Home, the scan button, Profile and the protected blocks are always shown, and the server refuses a
 * layout that hides one. An item whose switch is off stays off whatever the layout says. Below the lists, the ranking, Quests
 * and Rewards screens are given their layouts (T-611), and the phone shows the screen being styled.
 */
export function EventLayoutEditor(ids: Ids) {
  const t = useTranslator(ids.language);
  const read = usePreview(ids.organizerId, ids.eventId);
  return (
    <Stack>
      <PageHeader title={t("layout.title")} />
      {read.state === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {read.state === "failed" ? (
        <Notice role="alert" tone="danger">
          {t("preview.loadFailed")}
        </Notice>
      ) : null}
      {read.state === "ready" ? <Workspace {...ids} source={read.source} /> : null}
    </Stack>
  );
}
