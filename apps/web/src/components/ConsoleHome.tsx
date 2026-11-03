"use client";

import {
  QUESTIFY_HOME_BLOCKS,
  QUESTIFY_HOME_PROTECTED,
  checkQuestifyHome,
  sameQuestifyHome,
  type Language,
  type QuestifyHome,
  type QuestifyHomeBlock,
} from "@questify/shared";
import { useState } from "react";
import { BannerSlidesEditor } from "#src/components/BannerSlidesEditor.tsx";
import {
  CatalogState,
  EditorButtons,
  useCatalog,
  type Catalog,
} from "#src/components/CatalogParts.tsx";
import { EditorSection } from "#src/components/HomeContentFields.tsx";
import { ItemList, type LayoutItem } from "#src/components/LayoutItemList.tsx";
import { QuestifyHomePreview } from "#src/components/QuestifyHomePreview.tsx";
import styles from "#src/components/layout-editor.module.css";
import {
  HOME_LAYOUT_API,
  homeProblem,
  readHomeLayout,
  type HomeLayoutRow,
} from "#src/lib/console-home.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Badge, Notice, ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

/** A banner slide on Questify home opens nothing or a web link; the other taps belong to an event's screens. */
const HOME_TAPS = ["none", "link"] as const;

function blockItems(language: Language): readonly LayoutItem<QuestifyHomeBlock>[] {
  const t = translatorFor(language);
  return QUESTIFY_HOME_BLOCKS.map((entry) => ({
    key: entry.block,
    label: t(entry.title),
    isProtected: entry.protected,
    switchedOff: false,
    editable: entry.block === "banner",
  }));
}

function HomeEditor({
  language,
  catalog,
  row,
}: Readonly<{ language: Language; catalog: Catalog<HomeLayoutRow>; row: HomeLayoutRow }>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<QuestifyHome>(row.layout);
  const [editingBanner, setEditingBanner] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const unfinished = homeProblem(draft);
  const dirty = !sameQuestifyHome(row.layout, draft);
  const save = () => {
    const checked = checkQuestifyHome(draft);
    if (checked.ok) {
      void catalog.save("", checked.value);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className={styles.workspace}>
        <div className={styles.editor}>
          <Toolbar>
            {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
            <IconButton
              icon="undo"
              label={t("console.catalog.revert", { name: t("console.home.title") })}
              disabled={catalog.busy || !row.revertible}
              onClick={() => void catalog.revert("")}
            />
          </Toolbar>
          <ItemList
            language={language}
            title={t("console.home.blocks")}
            items={blockItems(language)}
            list={draft}
            protectedKeys={QUESTIFY_HOME_PROTECTED}
            onChange={(list, spoken) => {
              setDraft({ ...draft, order: list.order, hidden: list.hidden });
              if (spoken !== undefined) setAnnouncement(spoken);
            }}
            editing={editingBanner ? "banner" : null}
            onEdit={() => setEditingBanner(!editingBanner)}
          />
          {editingBanner ? (
            <EditorSection
              language={language}
              title={t("questifyHome.block.banner")}
              onClose={() => setEditingBanner(false)}
            >
              <BannerSlidesEditor
                language={language}
                slides={draft.banner}
                quests={[]}
                kinds={HOME_TAPS}
                onChange={(banner) => setDraft({ ...draft, banner })}
              />
            </EditorSection>
          ) : null}
          {dirty && unfinished !== null ? (
            <Notice role="status" tone="warning">
              {t(unfinished.key, { n: unfinished.n })}
            </Notice>
          ) : null}
          <EditorButtons
            language={language}
            busy={catalog.busy}
            canSave={dirty && unfinished === null}
            onDiscard={() => {
              setDraft(row.layout);
              setEditingBanner(false);
            }}
          />
          <ScreenReaderOnly>
            <span role="status" aria-live="polite">
              {announcement}
            </span>
          </ScreenReaderOnly>
        </div>
        <div className={styles.preview}>
          <QuestifyHomePreview layout={draft} language={language} />
        </div>
      </div>
    </form>
  );
}

/**
 * Questify home's layout (T-713, FR-1838): the blocks the app draws outside an event as rows to reorder (by dragging or with
 * the move buttons) and to show or hide, the banner's text slides under them, and the screen redrawn beside them as the draft
 * changes. The always-shown blocks move but cannot be hidden. A save is audited and reaches the apps within moments; the
 * revert puts back the layout before the latest change. Platform admins only.
 */
export function ConsoleHome({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, HOME_LAYOUT_API, readHomeLayout);
  return (
    <Stack as="section" aria-labelledby="console-home-title">
      <PageHeader
        titleId="console-home-title"
        title={t("console.home.title")}
        info={infoTip(t, "console.home.intro")}
      />
      <CatalogState language={language} catalog={catalog}>
        {(row) => (
          <HomeEditor
            key={JSON.stringify(row.layout)}
            language={language}
            catalog={catalog}
            row={row}
          />
        )}
      </CatalogState>
    </Stack>
  );
}
