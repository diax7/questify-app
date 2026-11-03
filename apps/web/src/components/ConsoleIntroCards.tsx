"use client";

import {
  PLAYER_INTRO_CARDS,
  checkPlayerIntro,
  samePlayerIntro,
  type IntroCardKey,
  type Language,
  type PlayerIntro,
} from "@questify/shared";
import { useState } from "react";
import {
  CatalogState,
  EditorButtons,
  useCatalog,
  type Catalog,
} from "#src/components/CatalogParts.tsx";
import { ItemList, type LayoutItem } from "#src/components/LayoutItemList.tsx";
import styles from "#src/components/layout-editor.module.css";
import {
  PLAYER_INTRO_API,
  hidesEveryCard,
  readPlayerIntroRow,
  type PlayerIntroRow,
} from "#src/lib/console-intro.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Badge, Notice, ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

/** No intro card is always shown: the only rule is that one stays, which the editor checks as a whole. */
const NONE_PROTECTED: ReadonlySet<IntroCardKey> = new Set();

function cardItems(language: Language): readonly LayoutItem<IntroCardKey>[] {
  const t = translatorFor(language);
  return PLAYER_INTRO_CARDS.map((entry) => ({
    key: entry.card,
    label: t(entry.title),
    isProtected: false,
    switchedOff: false,
  }));
}

function IntroEditor({
  language,
  catalog,
  row,
}: Readonly<{ language: Language; catalog: Catalog<PlayerIntroRow>; row: PlayerIntroRow }>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<PlayerIntro>(row.intro);
  const [announcement, setAnnouncement] = useState("");
  const none = hidesEveryCard(draft);
  const dirty = !samePlayerIntro(row.intro, draft);
  const save = () => {
    const checked = checkPlayerIntro(draft);
    if (checked.ok) {
      void catalog.save("", checked.value);
    }
  };
  return (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Toolbar>
        {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        <IconButton
          icon="undo"
          label={t("console.catalog.revert", { name: t("console.intro.title") })}
          disabled={catalog.busy || !row.revertible}
          onClick={() => void catalog.revert("")}
        />
      </Toolbar>
      <ItemList
        language={language}
        title={t("console.intro.cards")}
        items={cardItems(language)}
        list={draft}
        protectedKeys={NONE_PROTECTED}
        onChange={(list, spoken) => {
          setDraft(list);
          if (spoken !== undefined) setAnnouncement(spoken);
        }}
      />
      {dirty && none ? (
        <Notice role="status" tone="warning">
          {t("console.intro.noneShown")}
        </Notice>
      ) : null}
      <EditorButtons
        language={language}
        busy={catalog.busy}
        canSave={dirty && !none}
        onDiscard={() => setDraft(row.intro)}
      />
      <ScreenReaderOnly>
        <span role="status" aria-live="polite">
          {announcement}
        </span>
      </ScreenReaderOnly>
    </form>
  );
}

/**
 * The player intro's cards (T-802b, FR-1803): the four story cards a new player sees as rows to reorder (by dragging or with
 * the move buttons) and to show or hide, with at least one left shown. The words of the cards are edited in App texts. A save
 * is audited and reaches the apps within moments; the revert puts back the layout before the latest change. Platform admins
 * only.
 */
export function ConsoleIntroCards({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, PLAYER_INTRO_API, readPlayerIntroRow);
  return (
    <Stack as="section" aria-labelledby="console-intro-title">
      <PageHeader
        titleId="console-intro-title"
        title={t("console.intro.title")}
        info={infoTip(t, "console.intro.intro")}
      />
      <CatalogState language={language} catalog={catalog}>
        {(row) => (
          <IntroEditor
            key={JSON.stringify(row.intro)}
            language={language}
            catalog={catalog}
            row={row}
          />
        )}
      </CatalogState>
    </Stack>
  );
}
