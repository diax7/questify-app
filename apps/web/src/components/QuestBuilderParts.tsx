"use client";

import {
  QUEST_TYPES,
  formatEventTime,
  isLivePoll,
  formatNumber,
  termFor,
  toLocalInput,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { FlashControls, type FlashActions } from "#src/components/FlashControls.tsx";
import { PollControls, type PollActions } from "#src/components/PollControls.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import type { QuestItem } from "#src/lib/quest-items.ts";
import {
  categoryBody,
  categoryRuleNotes,
  moved,
  textFor,
  type CategoryRuleNote,
  type CategoryView,
  type QuestView,
} from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Form, Input, Radio, Select } from "#src/ui/Field.tsx";
import { TextLink } from "#src/ui/Text.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Card, CardList, SubHeading, Toolbar } from "#src/ui/Section.tsx";

/** How the picker holds its choice: in the form's state (the quest form), or as a named field (the category form). */
type PickerBinding =
  | Readonly<{ value: string; change: (itemId: string) => void }>
  | Readonly<{ name: string; initial: string }>;

/**
 * The item a quest or category gives (T-304d, FR-522): none, or one of the event's quest items, with the stock left;
 * the items themselves are managed on the Prizes page.
 */
export function ItemPicker({
  language,
  items,
  hint,
  busy,
  ...binding
}: Readonly<{
  language: Language;
  items: readonly QuestItem[];
  hint: MessageKey;
  busy: boolean;
}> &
  PickerBinding) {
  const t = useTranslator(language);
  const hintId = useId();
  const bound =
    "change" in binding
      ? {
          value: binding.value,
          onChange: (e: { target: { value: string } }) => binding.change(e.target.value),
        }
      : { name: binding.name, defaultValue: binding.initial };
  return (
    <>
      <Field label={t("questItems.picker")}>
        <Select aria-describedby={hintId} disabled={busy} {...bound}>
          <option value="">{t("questItems.pickerNone")}</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {`${textFor(item.name, language)} (${t("questItems.left", {
                left: formatNumber(item.stockLeft, language),
                total: formatNumber(item.stockTotal, language),
              })})`}
            </option>
          ))}
        </Select>
      </Field>
      <Muted id={hintId}>{t(hint)}</Muted>
    </>
  );
}

/** What the builder asks the person to confirm before it deletes. */
export type Deleting =
  | Readonly<{ kind: "quest"; quest: QuestView }>
  | Readonly<{ kind: "category"; category: CategoryView }>;

export type CardActions = PollActions &
  FlashActions &
  Readonly<{
    /** Where a quest's printed code is, for the types that have one. */
    codeLink: (quest: QuestView) => string | undefined;
    reorderCategories: (ids: string[]) => void;
    /** Asks to send a hidden category's hint (T-501g): the page counts who would be told, then confirms. */
    sendHint: (category: CategoryView) => void;
    /** Saves a category's names and rules (T-304). */
    saveCategory: (category: CategoryView, body: Record<string, unknown>) => void;
    reorderQuests: (category: CategoryView, ids: string[]) => void;
    toggle: (quest: QuestView) => void;
    pin: (quest: QuestView) => void;
    edit: (quest: QuestView) => void;
    add: (category: CategoryView) => void;
    remove: (target: Deleting) => void;
  }>;

/**
 * A heading that takes the focus when it appears, which also scrolls it into view: a dialog or form opened from far
 * down the page is seen at once, and a screen reader announces it.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/** Asks before a change reaches players of a live event (FR-1007), then sends it again with the confirmation. */
export function LiveDialog({
  language,
  busy,
  cancel,
  confirm,
}: Readonly<{ language: Language; busy: boolean; cancel: () => void; confirm: () => void }>) {
  const t = useTranslator(language);
  return (
    <Dialog
      titleId="live-title"
      title={t("quests.liveTitle")}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={confirm}>
            {t("common.continue")}
          </Button>
        </>
      }
    >
      <p>{t("quests.liveBody")}</p>
    </Dialog>
  );
}

/** Up and Down for a row: keyboard and screen-reader friendly, no dragging, nothing to flip for right-to-left. */
function OrderButtons({
  language,
  name,
  ids,
  index,
  busy,
  apply,
}: Readonly<{
  language: Language;
  /** What moves, so each button says which row it moves. */
  name: string;
  ids: readonly string[];
  index: number;
  busy: boolean;
  apply: (ids: string[]) => void;
}>) {
  const t = useTranslator(language);
  const up = moved(ids, index, -1);
  const down = moved(ids, index, 1);
  return (
    <>
      <Button
        variant="quiet"

        disabled={busy || up === undefined}
        aria-label={t("quests.upNamed", { name })}
        onClick={() => up && apply(up)}
      >
        {t("quests.up")}
      </Button>
      <Button
        variant="quiet"

        disabled={busy || down === undefined}
        aria-label={t("quests.downNamed", { name })}
        onClick={() => down && apply(down)}
      >
        {t("quests.down")}
      </Button>
    </>
  );
}

function QuestRow({
  language,
  timeZone,
  terms,
  quest,
  ids,
  index,
  busy,
  actions,
  category,
  pinned,
  readOnly,
}: Readonly<{
  language: Language;
  timeZone: string;
  terms: EventTerms;
  quest: QuestView;
  ids: readonly string[];
  index: number;
  busy: boolean;
  actions: CardActions;
  category: CategoryView;
  /** The event's Up next pin (FR-1748). */
  pinned: boolean;
  readOnly: boolean;
}>) {
  const t = useTranslator(language);
  const live = isLivePoll(quest.type, quest.config);
  const printHref = actions.codeLink(quest);
  const when = (iso: string | null, key: "quests.opens" | "quests.closes") =>
    iso === null || live ? null : (
      <Muted as="span">
        {t(key, { time: formatEventTime(new Date(iso), timeZone, language) })}
      </Muted>
    );
  return (
    <Card as="li">
      <Toolbar>
        <strong>{textFor(quest.title, language)}</strong>
        <Badge>{t(QUEST_TYPES[quest.type].label)}</Badge>
        {quest.visible || live ? null : <Badge tone="warning">{t("quests.hidden")}</Badge>}
        {pinned ? <Badge tone="info">{t("quests.pinned")}</Badge> : null}
        {(quest.firstBonus ?? null) === null ? null : (
          <Badge>
            {t("builder.firstBonus.listLeft", {
              slots: formatNumber(quest.firstBonus?.slots ?? 0, language),
              left: formatNumber(quest.firstBonus?.left ?? 0, language),
            })}
          </Badge>
        )}
      </Toolbar>
      <Toolbar>
        <Muted as="span">
          {t("quests.pointsShort", {
            currency: termFor(terms.currency, language),
            points: quest.points,
          })}
        </Muted>
        {quest.repeatCap > 1 ? (
          <Muted as="span">
            {t("quests.repeatShort", {
              player: terms.player[language].one,
              count: quest.repeatCap,
            })}
          </Muted>
        ) : null}
        {when(quest.opensAt, "quests.opens")}
        {when(quest.closesAt, "quests.closes")}
        {pinned && !quest.visible ? <Muted as="span">{t("quests.pinnedHidden")}</Muted> : null}
      </Toolbar>
      <PollControls
        language={language}
        timeZone={timeZone}
        quest={quest}
        busy={busy}
        readOnly={readOnly}
        actions={actions}
      />
      <FlashControls
        language={language}
        timeZone={timeZone}
        quest={quest}
        busy={busy}
        readOnly={readOnly}
        actions={actions}
      />
      {readOnly ? null : (
        <Toolbar>
          <OrderButtons
            language={language}
            name={textFor(quest.title, language)}
            ids={ids}
            index={index}
            busy={busy}
            apply={(order) => actions.reorderQuests(category, order)}
          />
          {live ? null : (
            <Button variant="quiet" disabled={busy} onClick={() => actions.toggle(quest)}>
              {quest.visible ? t("quests.hide") : t("quests.show")}
            </Button>
          )}
          <Button
            variant="quiet"
            disabled={busy}
            aria-pressed={pinned}
            onClick={() => actions.pin(quest)}
          >
            {t("quests.pin")}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => actions.edit(quest)}>
            {t("quests.edit")}
          </Button>
          {printHref === undefined ? null : (
            <TextLink href={printHref}>{t("codes.printQr")}</TextLink>
          )}
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => actions.remove({ kind: "quest", quest })}
          >
            {t("quests.delete")}
          </Button>
        </Toolbar>
      )}
    </Card>
  );
}

/** A rule note in words, for the category card. */
function ruleText(
  note: CategoryRuleNote,
  t: Translate,
  language: Language,
  timeZone: string,
): string {
  switch (note.kind) {
    case "inOrder":
      return t("quests.category.inOrder");
    case "opens":
      return t("quests.category.opens", {
        time: formatEventTime(new Date(note.at), timeZone, language),
      });
    case "unlockAfter":
      return t("quests.category.unlockAfter", { name: textFor(note.name, language) });
    case "bonus":
      return t("quests.category.bonus", { points: formatNumber(note.points, language) });
    case "resets":
      return t(
        note.refresh === "daily" ? "quests.category.resetsDaily" : "quests.category.resetsWeekly",
      );
    case "hidden":
      return t("quests.category.hidden");
  }
}

/**
 * A category's rules as form fields (T-304): its order, its opening time, its unlock and its completion bonus; its
 * refresh and whether it is hidden until found (T-304c).
 */
function CategoryRuleFields({
  language,
  timeZone,
  category,
  categories,
  items,
  busy,
}: Readonly<{
  language: Language;
  timeZone: string;
  category: CategoryView;
  categories: readonly CategoryView[];
  items: readonly QuestItem[];
  busy: boolean;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <Field label={t("quests.field.orderMode")}>
        <Select name="orderMode" defaultValue={category.orderMode} disabled={busy}>
          <option value="any">{t("quests.field.orderAny")}</option>
          <option value="in_order">{t("quests.field.orderInOrder")}</option>
        </Select>
      </Field>
      <Field label={t("quests.field.categoryOpensAt")}>
        <Input
          type="datetime-local"
          name="opensAt"
          dir="ltr"
          defaultValue={
            category.opensAt === null ? "" : toLocalInput(new Date(category.opensAt), timeZone)
          }
          disabled={busy}
        />
      </Field>
      <Field label={t("quests.field.unlockAfter")}>
        <Select name="unlockAfter" defaultValue={category.unlockAfter ?? ""} disabled={busy}>
          <option value="">{t("quests.field.unlockNone")}</option>
          {categories
            .filter((other) => other.id !== category.id)
            .map((other) => (
              <option key={other.id} value={other.id}>
                {textFor(other.name, language)}
              </option>
            ))}
        </Select>
      </Field>
      <Field label={t("quests.field.completionBonus")}>
        <Input
          type="number"
          name="completionBonus"
          dir="ltr"
          min={0}
          max={100_000}
          step={1}
          defaultValue={category.completionBonus}
          disabled={busy}
        />
      </Field>
      <ItemPicker
        language={language}
        items={items}
        hint="questItems.pickerCategory"
        busy={busy}
        name="itemId"
        initial={category.itemId ?? ""}
      />
      <Muted>{t("quests.field.rulesHint")}</Muted>
      <Field label={t("quests.field.refresh")}>
        <Select
          name="refresh"
          defaultValue={category.refresh}
          aria-describedby={`refresh-hint-${category.id}`}
          disabled={busy}
        >
          <option value="none">{t("quests.field.refreshNone")}</option>
          <option value="daily">{t("quests.field.refreshDaily")}</option>
          <option value="weekly">{t("quests.field.refreshWeekly")}</option>
        </Select>
      </Field>
      <Muted id={`refresh-hint-${category.id}`}>{t("quests.field.refreshHint")}</Muted>
      <Checkbox
        label={t("quests.field.hidden")}
        name="hidden"
        defaultChecked={category.hidden}
        aria-describedby={`hidden-hint-${category.id}`}
        disabled={busy}
      />
      <Muted id={`hidden-hint-${category.id}`}>{t("quests.field.hiddenHint")}</Muted>
    </>
  );
}

/** A category's buttons: move, send its hint when it is hidden (T-501g), edit and delete. */
function CategoryActions({
  language,
  category,
  order,
  index,
  busy,
  actions,
  rename,
  canDelete,
}: Readonly<{
  language: Language;
  category: CategoryView;
  order: readonly string[];
  index: number;
  busy: boolean;
  actions: CardActions;
  rename: () => void;
  canDelete: boolean;
}>) {
  const t = useTranslator(language);
  return (
    <Toolbar>
      <OrderButtons
        language={language}
        name={textFor(category.name, language)}
        ids={order}
        index={index}
        busy={busy}
        apply={actions.reorderCategories}
      />
      {category.hidden ? (
        <Button
          variant="quiet"

          disabled={busy}
          onClick={() => actions.sendHint(category)}
        >
          {t("quests.hint.send")}
        </Button>
      ) : null}
      <Button variant="quiet" disabled={busy} onClick={rename}>
        {t("quests.editCategory")}
      </Button>
      {canDelete ? (
        <Button
          variant="quiet"

          disabled={busy}
          onClick={() => actions.remove({ kind: "category", category })}
        >
          {t("quests.deleteCategory")}
        </Button>
      ) : null}
    </Toolbar>
  );
}

/** One category: its name, rules and order, and its quests in order (FR-1004, FR-229, T-304). */
export function CategoryCard({
  language,
  timeZone,
  terms,
  category,
  categories,
  items,
  order,
  index,
  busy,
  actions,
  focusQuestId,
  readOnly,
  canDelete,
}: Readonly<{
  language: Language;
  timeZone: string;
  terms: EventTerms;
  category: CategoryView;
  /** Every category of the event, for the unlock choice and its name. */
  categories: readonly CategoryView[];
  /** The event's quest items, for the item picker (T-304d). */
  items: readonly QuestItem[];
  order: readonly string[];
  index: number;
  busy: boolean;
  actions: CardActions;
  focusQuestId: string | null;
  /** An ended event: everything is shown, nothing changes. */
  readOnly: boolean;
  /** False for the last category: every event keeps one (FR-228). */
  canDelete: boolean;
}>) {
  const t = useTranslator(language);
  const [renaming, setRenaming] = useState(false);
  const questIds = category.quests.map((quest) => quest.id);
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    actions.saveCategory(category, categoryBody(new FormData(event.currentTarget)));
    setRenaming(false);
  };
  const notes = categoryRuleNotes(category, categories).map((note) =>
    ruleText(note, t, language, timeZone),
  );
  return (
    <Card as="section" aria-label={textFor(category.name, language)}>
      {renaming ? (
        <Form onSubmit={save}>
          <CategoryNameFields language={language} initial={category} busy={busy} />
          <CategoryRuleFields
            language={language}
            timeZone={timeZone}
            category={category}
            categories={categories}
            items={items}
            busy={busy}
          />
          <Toolbar>
            <Button variant="quiet" onClick={() => setRenaming(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {t("quests.saveCategory")}
            </Button>
          </Toolbar>
        </Form>
      ) : (
        <Toolbar align="between">
          <SubHeading as="h2">{textFor(category.name, language)}</SubHeading>
          {readOnly ? null : (
            <CategoryActions
              language={language}
              category={category}
              order={order}
              index={index}
              busy={busy}
              actions={actions}
              rename={() => setRenaming(true)}
              canDelete={canDelete}
            />
          )}
        </Toolbar>
      )}
      {renaming || notes.length === 0 ? null : <Muted>{notes.join(" · ")}</Muted>}
      {category.quests.length === 0 ? (
        <Muted>{t("quests.noQuests")}</Muted>
      ) : (
        <CardList>
          {category.quests.map((quest, questIndex) => (
            <QuestRow
              key={quest.id}
              language={language}
              timeZone={timeZone}
              terms={terms}
              quest={quest}
              ids={questIds}
              index={questIndex}
              busy={busy}
              actions={actions}
              category={category}
              pinned={quest.id === focusQuestId}
              readOnly={readOnly}
            />
          ))}
        </CardList>
      )}
      {readOnly ? null : (
        <Button
          variant="secondary"

          disabled={busy}
          onClick={() => actions.add(category)}
        >
          {t("quests.addQuest")}
        </Button>
      )}
    </Card>
  );
}

/** A category's two names, as form fields named `ar` and `en`. */
export function CategoryNameFields({
  language,
  initial,
  busy,
}: Readonly<{ language: Language; initial?: CategoryView | undefined; busy: boolean }>) {
  const t = useTranslator(language);
  return (
    <FieldGroup layout="columns">
      <Field label={t("quests.field.categoryAr")}>
        <Input
          name="ar"
          dir="rtl"
          maxLength={120}
          defaultValue={initial?.name.ar ?? ""}
          disabled={busy}
        />
      </Field>
      <Field label={t("quests.field.categoryEn")}>
        <Input
          name="en"
          dir="ltr"
          maxLength={120}
          defaultValue={initial?.name.en ?? ""}
          disabled={busy}
        />
      </Field>
    </FieldGroup>
  );
}

/**
 * The confirmation before a delete, naming what goes. A category that holds quests asks what happens to them: move
 * them to another category, or delete them with it (FR-1004).
 */
export function DeleteDialog({
  language,
  target,
  categories,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  target: Deleting;
  categories: readonly CategoryView[];
  busy: boolean;
  cancel: () => void;
  confirm: (choice: Readonly<Record<string, unknown>>) => void;
}>) {
  const t = useTranslator(language);
  const others =
    target.kind === "category" ? categories.filter((item) => item.id !== target.category.id) : [];
  // No choice is made for the person: the button waits until they pick one (the UX confirmation pattern).
  const [choice, setChoice] = useState<string | null>(null);
  const holds = target.kind === "category" ? target.category.quests.length : 0;
  const name =
    target.kind === "quest"
      ? textFor(target.quest.title, language)
      : textFor(target.category.name, language);
  const go = () =>
    confirm(
      holds === 0
        ? {}
        : choice === "delete"
          ? { quests: "delete" }
          : { quests: "move", to: choice },
    );
  return (
    <Dialog
      titleId="delete-title"
      title={t(target.kind === "quest" ? "quests.deleteTitle" : "quests.deleteCategoryTitle")}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={busy || (holds > 0 && choice === null)} onClick={go}>
            {t(target.kind === "quest" ? "quests.delete" : "quests.deleteCategory")}
          </Button>
        </>
      }
    >
      {holds === 0 ? (
        <p>
          {t(target.kind === "quest" ? "quests.deleteBody" : "quests.deleteCategoryBody", { name })}
        </p>
      ) : (
        <FieldGroup
          legend={t("quests.deleteCategoryHolds", { name, count: holds })}
          layout="choices"
        >
          {others.map((other) => (
            <Radio
              key={other.id}
              label={
                <>
                  {t("quests.moveTo")} {textFor(other.name, language)}
                </>
              }
              name="fate"
              checked={choice === other.id}
              onChange={() => setChoice(other.id)}
            />
          ))}
          <Radio
            label={t("quests.deleteThem")}
            name="fate"
            checked={choice === "delete"}
            onChange={() => setChoice("delete")}
          />
        </FieldGroup>
      )}
    </Dialog>
  );
}
