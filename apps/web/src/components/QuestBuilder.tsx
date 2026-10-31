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
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const categoryKey = useRef(crypto.randomUUID());
  const focus = useReturnFocus("builder-title");
  const categories = b.categories ?? [];
  const timeZone = b.event?.timezone ?? "Asia/Riyadh";
  const terms = b.event?.terms ?? DEFAULT_TERMS;
  const live = b.event?.statusNow === "live";
  const closed = b.event?.statusNow === "ended" || b.event?.statusNow === "archived";

  const hint = useCategoryHint({ language, builder: b, live, focus });
  const liveEdits = useLiveEdits({ language, builder: b, live, focus });
  const closeEditing = () => {
    setEditing(null);
    focus.restore();
  };
  const codesPage = `/${language}/organizers/${organizerId}/events/${eventId}/codes`;
  const liveActions = useQuestLiveActions({
    language,
    builder: b,
    focus,
    votesUrl: (quest) => `/v1/organizers/${organizerId}/events/${eventId}/quests/${quest.id}/votes`,
  });
  const actions: CardActions = {
    sendHint: hint.ask,
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
    edit: (quest) => {
      focus.remember();
      setEditing({ quest, initial: questDraftOf(quest, timeZone), key: crypto.randomUUID() });
    },
    add: (category) => {
      focus.remember();
      setEditing({ initial: blankQuest(category.id), key: crypto.randomUUID() });
    },
    remove: (target) => liveEdits.remove(target, setDeleting),
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
    <Stack as="section" aria-labelledby="builder-title">
      <PageHeader
        back={{
          href: `/${language}/organizers/${organizerId}/events/${eventId}`,
          label: b.event?.name ?? t("events.all"),
        }}
        titleId="builder-title"
        focusable
        title={t("quests.title")}
        actions={<ButtonLink href={codesPage}>{t("codes.title")}</ButtonLink>}
      />
      {live ? (
        <Notice tone="success" role="status">
          {t("quests.liveBanner")}
        </Notice>
      ) : null}
      {closed ? <Muted>{t("quests.closedNote")}</Muted> : null}
      {b.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {b.problem}
        </Notice>
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
      {hint.note}
      {hint.dialog}
      {liveActions.dialogs}
      {liveEdits.dialogs}
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
          nfcTags={
            editing.quest?.type === "scan_qr"
              ? {
                  eventApi: `/v1/organizers/${organizerId}/events/${eventId}`,
                  questId: editing.quest.id,
                  targets: moveTargets(categories, editing.quest.id),
                  nfcOn: editing.quest.verification.includes("nfc"),
                }
              : null
          }
          busy={b.busy}
          save={save}
          cancel={closeEditing}
        />
      )}
      {b.categories === null ? (
        b.problem === null ? (
          <Muted>{t("common.loading")}</Muted>
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
        <Card>
          <Form onSubmit={addCategory}>
            <CategoryNameFields language={language} busy={b.busy} />
            <Button variant="secondary" type="submit" disabled={b.busy}>
              {t("quests.addCategory")}
            </Button>
          </Form>
        </Card>
      )}
    </Stack>
  );
}
