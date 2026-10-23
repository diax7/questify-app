"use client";

import { DEFAULT_TERMS, QUEST_TYPES, type Language } from "@questify/shared";
import { useRef, useState, type FormEvent } from "react";
import {
  CategoryCard,
  CategoryNameFields,
  DeleteDialog,
  LiveDialog,
  type CardActions,
  type Deleting,
} from "#src/components/QuestBuilderParts.tsx";
import { QuestForm } from "#src/components/QuestForm.tsx";
import { useQuestBuilder } from "#src/components/useQuestBuilder.ts";
import { translatorFor } from "#src/lib/language.ts";
import {
  blankQuest,
  createQuestBody,
  editQuestBody,
  invalidQuestKey,
  questDraftOf,
  questProblem,
  type QuestDraft,
  type QuestView,
} from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

/** The quest form while it is open, with its own Idempotency-Key for as long as this draft lives. */
type Editing = Readonly<{ quest?: QuestView; initial: QuestDraft; key: string }>;

/**
 * Remembers the control that opened a dialog or form, and gives it the focus back when that closes, so a keyboard or
 * screen-reader user carries on where they were.
 */
function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember: () => {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    restore: () => {
      const target = opener.current;
      opener.current = null;
      // After the closing render. An opener that is gone (the deleted category's own button) hands the focus to the
      // page's heading, never to nowhere.
      setTimeout(() => {
        const fallback = document.getElementById("builder-title");
        (target?.isConnected === true ? target : fallback)?.focus();
      }, 0);
    },
  };
}

/**
 * An event's categories and quests (FR-1004–1008, FR-226–229): add, edit, hide, reorder and delete. While the event is
 * live, the API holds each change for a confirmation, which this page asks for and then sends again; once it has
 * ended, everything is shown and nothing changes.
 */
export function QuestBuilder({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = translatorFor(language);
  const b = useQuestBuilder(language, organizerId, eventId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const categoryKey = useRef(crypto.randomUUID());
  const focus = useReturnFocus();
  const categories = b.categories ?? [];
  const timeZone = b.event?.timezone ?? "Asia/Riyadh";
  const terms = b.event?.terms ?? DEFAULT_TERMS;
  const live = b.event?.statusNow === "live";
  const closed = b.event?.statusNow === "ended" || b.event?.statusNow === "archived";

  const closeEditing = () => {
    setEditing(null);
    focus.restore();
  };
  const codesPage = `/${language}/organizers/${organizerId}/events/${eventId}/codes`;
  const actions: CardActions = {
    codeLink: (quest) =>
      QUEST_TYPES[quest.type].usesQuestQr ? `${codesPage}#code-${quest.id}` : undefined,
    reorderCategories: (ids) => void b.send("PUT", "/categories/order", { ids }),
    saveCategory: (category, body) => void b.send("PATCH", `/categories/${category.id}`, body),
    reorderQuests: (category, ids) =>
      void b.send("PUT", `/categories/${category.id}/quests/order`, { ids }),
    toggle: (quest) => void b.send("PATCH", `/quests/${quest.id}`, { visible: !quest.visible }),
    // One pin per event (FR-1748): pinning another moves it, pressing the pinned one clears it.
    pin: (quest) =>
      void b.send("PUT", "/focus", { questId: b.focusQuestId === quest.id ? null : quest.id }),
    edit: (quest) => {
      focus.remember();
      setEditing({ quest, initial: questDraftOf(quest, timeZone), key: crypto.randomUUID() });
    },
    add: (category) => {
      focus.remember();
      setEditing({ initial: blankQuest(category.id), key: crypto.randomUUID() });
    },
    remove: (target) => {
      focus.remember();
      setDeleting(target);
    },
  };

  const save = (draft: QuestDraft) => {
    if (editing === null) {
      return;
    }
    // Checked here first with the shared rules, so a live event's confirmation is never asked for a doomed change.
    const field = questProblem(draft);
    if (field !== undefined) {
      b.setProblem(t(invalidQuestKey(field)));
      return;
    }
    if (editing.quest === undefined) {
      void b.send("POST", "/quests", createQuestBody(draft), {
        key: editing.key,
        after: closeEditing,
      });
      return;
    }
    const body = editQuestBody(draft, editing.initial);
    if (Object.keys(body).length === 0) {
      closeEditing();
      return;
    }
    void b.send("PATCH", `/quests/${editing.quest.id}`, body, { after: closeEditing });
  };

  const addCategory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void b.send(
      "POST",
      "/categories",
      { name: { ar: String(data.get("ar")), en: String(data.get("en")) } },
      {
        key: categoryKey.current,
        after: () => {
          form.reset();
          categoryKey.current = crypto.randomUUID();
        },
      },
    );
  };

  const confirmDelete = (choice: Readonly<Record<string, unknown>>) => {
    if (deleting === null) {
      return;
    }
    const path =
      deleting.kind === "quest"
        ? `/quests/${deleting.quest.id}`
        : `/categories/${deleting.category.id}`;
    setDeleting(null);
    // The delete dialog already said what happens, so a live event is not asked a second time. The focus goes back
    // once the list has reloaded, when it is clear whether the opener is still there.
    void b
      .send("DELETE", path, live ? { ...choice, confirm: true } : choice)
      .then(() => focus.restore());
  };

  return (
    <section className={styles.panel} aria-labelledby="builder-title">
      <a
        className={styles.textLink}
        href={`/${language}/organizers/${organizerId}/events/${eventId}`}
      >
        {b.event?.name ?? t("events.all")}
      </a>
      <h1 id="builder-title" tabIndex={-1} className={styles.title}>
        {t("quests.title")}
      </h1>
      <a className={styles.textLink} href={codesPage}>
        {t("codes.title")}
      </a>
      {live ? (
        <p role="status" className={styles.notice}>
          {t("quests.liveBanner")}
        </p>
      ) : null}
      {closed ? <p className={styles.muted}>{t("quests.closedNote")}</p> : null}
      {b.problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {b.problem}
        </p>
      )}
      {b.pending === null ? null : (
        <LiveDialog
          language={language}
          busy={b.busy}
          cancel={b.cancelPending}
          confirm={() => void b.confirmPending()}
        />
      )}
      {deleting === null ? null : (
        <DeleteDialog
          language={language}
          target={deleting}
          categories={categories}
          busy={b.busy}
          cancel={() => {
            setDeleting(null);
            focus.restore();
          }}
          confirm={confirmDelete}
        />
      )}
      {editing === null ? null : (
        <QuestForm
          language={language}
          timeZone={timeZone}
          terms={terms}
          categories={categories}
          items={b.items}
          initial={editing.initial}
          isNew={editing.quest === undefined}
          locationQuestsOn={b.locationQuestsOn}
          votesUrl={
            editing.quest?.type === "vote"
              ? `/v1/organizers/${organizerId}/events/${eventId}/quests/${editing.quest.id}/votes`
              : null
          }
          surveyUrl={
            editing.quest?.type === "survey"
              ? `/v1/organizers/${organizerId}/events/${eventId}/quests/${editing.quest.id}/survey`
              : null
          }
          busy={b.busy}
          save={save}
          cancel={closeEditing}
        />
      )}
      {b.categories === null ? (
        b.problem === null ? (
          <p className={styles.muted}>{t("common.loading")}</p>
        ) : null
      ) : (
        categories.map((category, index) => (
          <CategoryCard
            key={category.id}
            language={language}
            timeZone={timeZone}
            terms={terms}
            category={category}
            categories={categories}
            items={b.items}
            order={categories.map((item) => item.id)}
            index={index}
            busy={b.busy}
            actions={actions}
            focusQuestId={b.focusQuestId}
            readOnly={closed}
            canDelete={categories.length > 1}
          />
        ))
      )}
      {closed ? null : (
        <form className={styles.form} onSubmit={addCategory}>
          <CategoryNameFields language={language} busy={b.busy} />
          <button type="submit" className={styles.button} disabled={b.busy}>
            {t("quests.addCategory")}
          </button>
        </form>
      )}
    </section>
  );
}
