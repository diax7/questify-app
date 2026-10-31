"use client";

import {
  BAR_PROTECTED,
  HOME_BLOCKS,
  HOME_PROTECTED,
  LAYOUT_PRESETS,
  PLAYER_TABS,
  homeBlocks,
  matchingPreset,
  playerTabs,
  presetLayout,
  readEventLayout,
  sameLayout,
  type EventLayout,
  type HomeBlock,
  type Language,
  type MessageKey,
  type PlayerTab,
} from "@questify/shared";
import { useMemo, useState } from "react";
import { ItemList, type LayoutItem } from "#src/components/LayoutItemList.tsx";
import { HomePreview } from "#src/components/PreviewScreens.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/layout-editor.module.css";
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

const bodyOf = (layout: EventLayout) => ({ bar: layout.bar, home: layout.home });

/** The name of an item the API refused to hide, in either list. */
function protectedName(item: unknown, t: (key: MessageKey) => string): string | undefined {
  const key =
    PLAYER_TABS.find((entry) => entry.tab === item)?.title ??
    HOME_BLOCKS.find((entry) => entry.block === item)?.title;
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

function homeItems(
  t: (key: MessageKey) => string,
  on: (feature: string) => boolean,
): readonly LayoutItem<HomeBlock>[] {
  return HOME_BLOCKS.map((entry) => ({
    key: entry.block,
    label: t(entry.title),
    isProtected: HOME_PROTECTED.has(entry.block),
    switchedOff: homeBlocks(on, [entry.block]).length === 0,
  }));
}

function Presets({
  language,
  current,
  disabled,
  onPick,
}: Readonly<{
  language: Language;
  current: string | null;
  disabled: boolean;
  onPick: (id: string) => void;
}>) {
  const t = useTranslator(language);
  return (
    <Section
      title={t("layout.presets")}
      actions={current === null ? <Badge>{t("layout.custom")}</Badge> : undefined}
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

function Workspace({ source, ...ids }: Ids & Readonly<{ source: PreviewSource }>) {
  const { language } = ids;
  const t = useTranslator(language);
  const start = useMemo(() => readEventLayout(source.event.layout), [source.event.layout]);
  const [saved, setSaved] = useState(start);
  const [draft, setDraft] = useState(start);
  const [done, setDone] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const { busy, problem, save, clearProblem } = useLayoutSave(ids);
  const on = featureLookup(source.event);
  const dirty = !sameLayout(saved, draft);

  const adopt = (stored: EventLayout | null) => {
    if (stored !== null) {
      setSaved(stored);
      setDraft(stored);
      setDone(true);
    }
  };
  // The preset shows at once, and goes back to what it was if the server refuses.
  const pick = (id: string) => {
    const before = draft;
    const chosen = presetLayout(id);
    if (chosen !== undefined) setDraft(chosen);
    void save({ preset: id }).then((stored) =>
      stored === null ? setDraft(before) : adopt(stored),
    );
  };
  const edit = (next: EventLayout, spoken?: string) => {
    setDraft(next);
    setDone(false);
    clearProblem();
    if (spoken !== undefined) setAnnouncement(spoken);
  };
  const preview = previewOf(
    { ...source.event, layout: draft },
    source.categories,
    source.rewards,
    language,
  );

  return (
    <div className={styles.workspace}>
      <div className={styles.editor}>
        <Presets
          language={language}
          current={matchingPreset(draft)?.id ?? null}
          disabled={busy}
          onPick={pick}
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
          items={homeItems(t, on)}
          list={draft.home}
          protectedKeys={HOME_PROTECTED}
          onChange={(home, spoken) => edit({ ...draft, home }, spoken)}
        />
        <Toolbar>
          <Button
            variant="primary"
            disabled={!dirty || busy}
            onClick={() => void save(bodyOf(draft)).then(adopt)}
          >
            {t("layout.save")}
          </Button>
          <Button variant="quiet" disabled={!dirty || busy} onClick={() => edit(saved)}>
            {t("layout.discard")}
          </Button>
        </Toolbar>
        {problem === null ? null : (
          <Notice role="alert" tone="danger">
            {problem}
          </Notice>
        )}
        {done && !dirty ? (
          <Notice role="status" tone="success">
            {t("layout.saved")}
          </Notice>
        ) : null}
        <ScreenReaderOnly>
          <span role="status" aria-live="polite">
            {announcement}
          </span>
        </ScreenReaderOnly>
      </div>
      <div className={styles.preview}>
        <HomePreview preview={preview} language={language} />
      </div>
    </div>
  );
}

/**
 * The event's layout (FR-1749, FR-1764, T-606): the approved presets in one tap, then the bottom bar and the Home blocks as
 * two lists to reorder (by dragging or with the move buttons) and to show or hide, with the Home screen redrawn as the
 * organizer arranges it. Home, the scan button, Profile and the protected blocks are always shown, and the server refuses a
 * layout that hides one. An item whose switch is off stays off whatever the layout says.
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
