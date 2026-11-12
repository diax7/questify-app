"use client";

import { ExplainThis } from "#src/components/ExplainThis.tsx";
import { DEFAULT_TERMS, QUEST_TYPES, type EventTerms, type Language } from "@questify/shared";
import { useRef, useState, type FormEvent } from "react";
import {
  CategoryCard,
  CategoryNameFields,
  DeleteDialog,
  LiveDialog,
  type CardActions,
  type Deleting,
} from "#src/components/QuestBuilderParts.tsx";
import { useLiveEdits } from "#src/components/LiveEditDialogs.tsx";
import { QuestForm } from "#src/components/QuestForm.tsx";
import { useCategoryHint } from "#src/components/useCategoryHint.tsx";
import { useQuestBuilder } from "#src/components/useQuestBuilder.ts";
import { useQuestLiveActions } from "#src/components/useQuestLiveActions.tsx";
import { useReturnFocus } from "#src/components/useReturnFocus.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { moveTargets } from "#src/lib/nfc-tags.ts";
import {
  blankQuest,
  createQuestBody,
  editQuestBody,
  invalidQuestKey,
  questDraftOf,
  questProblem,
  type CategoryView,
  type QuestDraft,
  type QuestView,
} from "#src/lib/quests.ts";
import { Button, ButtonLink } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Form } from "#src/ui/Field.tsx";
import { Card, Stack } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";

/** The quest form while it is open, with its own Idempotency-Key for as long as this draft lives. */
type Editing = Readonly<{ quest?: QuestView; initial: QuestDraft; key: string }>;

/** The builder's header: the way back to the event, the codes page and "Explain this" (FR-1756). */
function BuilderHeader({
  language,
  organizerId,
  eventId,
  eventName,
}: Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  eventName: string | undefined;
}>) {
  const t = useTranslator(language);
  const eventPage = `/${language}/organizers/${organizerId}/events/${eventId}`;
  return (
    <PageHeader
      back={{ href: eventPage, label: eventName ?? t("events.all") }}
      titleId="builder-title"
      focusable
      title={t("quests.title")}
      actions={
        <>
          <ButtonLink href={`${eventPage}/codes`}>{t("codes.title")}</ButtonLink>
          <ExplainThis
            language={language}
            organizerId={organizerId}
            eventId={eventId}
            slug="quests"
          />
        </>
      }
    />
  );
}

type Builder = ReturnType<typeof useQuestBuilder>;
type Focus = ReturnType<typeof useReturnFocus>;
type LiveEdits = ReturnType<typeof useLiveEdits>;

/** The quest form's open state, and what Save sends: a create, or an edit of only what changed. */
function useQuestEditor({
  builder: b,
  timeZone,
  liveEdits,
  focus,
  t,
}: Readonly<{
  builder: Builder;
  timeZone: string;
  liveEdits: LiveEdits;
  focus: Focus;
  t: ReturnType<typeof useTranslator>;
}>) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const closeEditing = () => {
    setEditing(null);
    focus.restore();
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
    liveEdits.save({ quest: editing.quest, body, key: editing.key, after: closeEditing });
  };
  const open = (quest: QuestView | undefined, initial: QuestDraft) => {
    focus.remember();
    setEditing({ ...(quest === undefined ? {} : { quest }), initial, key: crypto.randomUUID() });
  };
  return {
    editing,
    closeEditing,
    save,
    edit: (quest: QuestView) => open(quest, questDraftOf(quest, timeZone)),
    add: (category: CategoryView) => open(undefined, blankQuest(category.id)),
  };
}

/** The delete dialog's open state and what Confirm sends. */
function useDeleteFlow({
  builder: b,
  live,
  focus,
}: Readonly<{ builder: Builder; live: boolean; focus: Focus }>) {
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const cancel = () => {
    setDeleting(null);
    focus.restore();
  };
  const confirm = (choice: Readonly<Record<string, unknown>>) => {
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
  return { deleting, setDeleting, cancel, confirm };
}

/** What the category cards can do: the page's own requests, plus the hint and live-quest actions. */
function useCardActions({
  builder: b,
  codesPage,
  hint,
  liveActions,
  editor,
  liveEdits,
  setDeleting,
}: Readonly<{
  builder: Builder;
  codesPage: string;
  hint: ReturnType<typeof useCategoryHint>;
  liveActions: ReturnType<typeof useQuestLiveActions>;
  editor: ReturnType<typeof useQuestEditor>;
  liveEdits: LiveEdits;
  setDeleting: (target: Deleting) => void;
}>): CardActions {
  return {
    sendHint: hint.ask,
    hintNote: hint.note,
    ...liveActions.actions,
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
    edit: editor.edit,
    add: editor.add,
    remove: (target) => liveEdits.remove(target, setDeleting),
  };
}

/** The quest form for the draft being edited, with the links of the type's own tools. */
function EditingForm({
  language,
  organizerId,
  eventId,
  builder: b,
  editing,
  timeZone,
  terms,
  save,
  cancel,
}: Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  builder: Builder;
  editing: Editing;
  timeZone: string;
  terms: EventTerms;
  save: (draft: QuestDraft) => void;
  cancel: () => void;
}>) {
  const categories = b.categories ?? [];
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const quest = editing.quest;
  return (
    <QuestForm
      language={language}
      timeZone={timeZone}
      terms={terms}
      categories={categories}
      items={b.items}
      initial={editing.initial}
      isNew={quest === undefined}
      locationQuestsOn={b.locationQuestsOn}
      photosOn={b.photosOn}
      votesUrl={quest?.type === "vote" ? `${eventApi}/quests/${quest.id}/votes` : null}
      surveyUrl={quest?.type === "survey" ? `${eventApi}/quests/${quest.id}/survey` : null}
      nfcTags={
        quest?.type === "scan_qr"
          ? {
              eventApi,
              questId: quest.id,
              targets: moveTargets(categories, quest.id),
              nfcOn: quest.verification.includes("nfc"),
            }
          : null
      }
      busy={b.busy}
      save={save}
      cancel={cancel}
    />
  );
}

/** The add-category form at the foot of the page, with its own Idempotency-Key until a category is added. */
function AddCategoryForm({
  language,
  builder: b,
}: Readonly<{ language: Language; builder: Builder }>) {
  const t = useTranslator(language);
  const categoryKey = useRef(crypto.randomUUID());
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
  return (
    <Card>
      <Form onSubmit={addCategory}>
        <CategoryNameFields language={language} busy={b.busy} />
        <Button variant="secondary" type="submit" disabled={b.busy}>
          {t("quests.addCategory")}
        </Button>
      </Form>
    </Card>
  );
}

/** What the page reads of the event: its zone and terms (with defaults while it loads), whether it is live or over. */
function eventFacts(event: Builder["event"]) {
  const status = event?.statusNow;
  return {
    timeZone: event?.timezone ?? "Asia/Riyadh",
    terms: event?.terms ?? DEFAULT_TERMS,
    live: status === "live",
    closed: status === "ended" || status === "archived",
    eventName: event?.name,
  };
}

/** The confirmation the API asked for, and the delete dialog. */
function BuilderDialogs({
  language,
  builder: b,
  deleteFlow,
}: Readonly<{
  language: Language;
  builder: Builder;
  deleteFlow: ReturnType<typeof useDeleteFlow>;
}>) {
  return (
    <>
      {b.pending === null ? null : (
        <LiveDialog
          language={language}
          busy={b.busy}
          cancel={b.cancelPending}
          confirm={() => void b.confirmPending()}
        />
      )}
      {deleteFlow.deleting === null ? null : (
        <DeleteDialog
          language={language}
          target={deleteFlow.deleting}
          categories={b.categories ?? []}
          busy={b.busy}
          cancel={deleteFlow.cancel}
          confirm={deleteFlow.confirm}
        />
      )}
    </>
  );
}

/** The live banner, the ended-event note and the last problem, each only when there is one. */
function BuilderNotices({
  language,
  live,
  closed,
  problem,
}: Readonly<{ language: Language; live: boolean; closed: boolean; problem: string | null }>) {
  const t = useTranslator(language);
  return (
    <>
      {live ? (
        <Notice tone="success" role="status">
          {t("quests.liveBanner")}
        </Notice>
      ) : null}
      {closed ? <Muted>{t("quests.closedNote")}</Muted> : null}
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
    </>
  );
}

/** The category cards, or the loading note while the first load runs (nothing when it failed). */
function CategoryList({
  language,
  builder: b,
  timeZone,
  terms,
  actions,
  closed,
}: Readonly<{
  language: Language;
  builder: Builder;
  timeZone: string;
  terms: EventTerms;
  actions: CardActions;
  closed: boolean;
}>) {
  const t = useTranslator(language);
  const categories = b.categories;
  if (categories === null) {
    return b.problem === null ? <Muted>{t("common.loading")}</Muted> : null;
  }
  return categories.map((category, index) => (
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
  ));
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
  const t = useTranslator(language);
  const b = useQuestBuilder(language, organizerId, eventId);
  const focus = useReturnFocus("builder-title");
  const { timeZone, terms, live, closed, eventName } = eventFacts(b.event);

  const hint = useCategoryHint({ language, builder: b, live, focus });
  const liveEdits = useLiveEdits({ language, builder: b, live, focus });
  const editor = useQuestEditor({ builder: b, timeZone, liveEdits, focus, t });
  const del = useDeleteFlow({ builder: b, live, focus });
  const liveActions = useQuestLiveActions({
    language,
    builder: b,
    focus,
    votesUrl: (quest) => `/v1/organizers/${organizerId}/events/${eventId}/quests/${quest.id}/votes`,
  });
  const actions = useCardActions({
    builder: b,
    codesPage: `/${language}/organizers/${organizerId}/events/${eventId}/codes`,
    hint,
    liveActions,
    editor,
    liveEdits,
    setDeleting: del.setDeleting,
  });

  return (
    <Stack as="section" aria-labelledby="builder-title">
      <BuilderHeader
        language={language}
        organizerId={organizerId}
        eventId={eventId}
        eventName={eventName}
      />
      <BuilderNotices language={language} live={live} closed={closed} problem={b.problem} />
      <BuilderDialogs language={language} builder={b} deleteFlow={del} />
      {hint.dialog}
      {liveActions.dialogs}
      {liveEdits.dialogs}
      {editor.editing === null ? null : (
        <EditingForm
          language={language}
          organizerId={organizerId}
          eventId={eventId}
          builder={b}
          editing={editor.editing}
          timeZone={timeZone}
          terms={terms}
          save={editor.save}
          cancel={editor.closeEditing}
        />
      )}
      <CategoryList
        language={language}
        builder={b}
        timeZone={timeZone}
        terms={terms}
        actions={actions}
        closed={closed}
      />
      {closed ? null : <AddCategoryForm language={language} builder={b} />}
    </Stack>
  );
}
