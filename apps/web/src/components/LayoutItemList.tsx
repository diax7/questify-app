"use client";

import type { Language, LayoutList } from "@questify/shared";
import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import styles from "#src/components/layout-editor.module.css";
import { moveBy, moveTo, positionOf, setShown } from "#src/lib/layout-editor.ts";
import { Badge, ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import { Switch } from "#src/ui/Field.tsx";
import { Icon } from "#src/ui/Icon.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Section } from "#src/ui/Section.tsx";

/** One item of a layout list as the organizer sees it. */
export type LayoutItem<K extends string> = Readonly<{
  key: K;
  label: string;
  /** Always shown: the layout cannot hide it (FR-1750). */
  isProtected: boolean;
  /** Its event switch is off, so players do not see it whatever the layout says. */
  switchedOff: boolean;
  /** Holds words or links the organizer writes (T-610): the row gets an Edit button. */
  editable?: boolean;
  /** Is the organizer's own card (T-610): the row gets a Remove button. */
  removable?: boolean;
}>;

type ListProps<K extends string> = Readonly<{
  language: Language;
  title: string;
  items: readonly LayoutItem<K>[];
  list: LayoutList<K>;
  protectedKeys: ReadonlySet<K>;
  /** The new list, and the words a screen reader hears after a move. */
  onChange: (next: LayoutList<K>, spoken?: string) => void;
  /** Buttons beside the list's title (add a card). */
  actions?: ReactNode;
  /** The row being edited below the list, marked for a screen reader. */
  editing?: K | null;
  onEdit?: (key: K) => void;
  onRemove?: (key: K) => void;
}>;

type RowProps<K extends string> = Readonly<{
  language: Language;
  item: LayoutItem<K>;
  list: LayoutList<K>;
  protectedKeys: ReadonlySet<K>;
  drag: K | null;
  over: K | null;
  dragging: Readonly<{
    start: (key: K) => void;
    over: (key: K) => void;
    drop: (key: K) => void;
    end: () => void;
  }>;
  onChange: ListProps<K>["onChange"];
  editing: K | null;
  onEdit: ListProps<K>["onEdit"];
  onRemove: ListProps<K>["onRemove"];
}>;

/** Edit and Remove, for the rows that hold the organizer's own words (T-610). */
function EditTools<K extends string>({
  language,
  item,
  editing,
  onEdit,
  onRemove,
}: Readonly<{
  language: Language;
  item: LayoutItem<K>;
  editing: K | null;
  onEdit: ListProps<K>["onEdit"];
  onRemove: ListProps<K>["onRemove"];
}>) {
  const t = useTranslator(language);
  return (
    <>
      {item.editable === true && onEdit !== undefined ? (
        <IconButton
          icon="edit"
          label={t("layout.edit", { item: item.label })}
          aria-pressed={editing === item.key}
          onClick={() => onEdit(item.key)}
        />
      ) : null}
      {item.removable === true && onRemove !== undefined ? (
        <IconButton
          icon="trash"
          label={t("layout.remove", { item: item.label })}
          onClick={() => onRemove(item.key)}
        />
      ) : null}
    </>
  );
}

/** A row's drag events: pick it up, pass over another row, and drop on one. */
function dragHandlers<K extends string>(key: K, drag: K | null, dragging: RowProps<K>["dragging"]) {
  return {
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
      dragging.start(key);
    },
    onDragOver: (event: DragEvent) => {
      if (drag !== null) {
        event.preventDefault();
        dragging.over(key);
      }
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      dragging.drop(key);
    },
  };
}

function Row<K extends string>({
  language,
  item,
  list,
  protectedKeys,
  drag,
  over,
  dragging,
  onChange,
  editing,
  onEdit,
  onRemove,
}: RowProps<K>) {
  const t = useTranslator(language);
  const index = list.order.indexOf(item.key);
  const move = (step: -1 | 1) => {
    const target = index + step;
    if (target < 0 || target >= list.order.length) return;
    const next = moveBy(list, item.key, step);
    onChange(
      next,
      t("layout.moved", {
        item: item.label,
        position: positionOf(next, item.key),
        total: next.order.length,
      }),
    );
  };
  return (
    <li
      className={styles.item}
      data-dragging={drag === item.key}
      data-over={over === item.key && drag !== item.key}
      draggable
      {...dragHandlers(item.key, drag, dragging)}
      onDragEnd={dragging.end}
    >
      <span
        className={styles.grip}
        aria-hidden="true"
        title={t("layout.drag", { item: item.label })}
      >
        <Icon name="grip" />
      </span>
      <span className={styles.name}>
        {item.label}
        {item.isProtected ? (
          <Badge>
            <Icon name="lock" /> {t("layout.alwaysShown")}
          </Badge>
        ) : null}
        {item.switchedOff ? <Badge tone="warning">{t("layout.switchedOff")}</Badge> : null}
      </span>
      <span className={styles.tools}>
        <Switch
          label={<ScreenReaderOnly>{t("layout.show", { item: item.label })}</ScreenReaderOnly>}
          checked={!list.hidden.includes(item.key)}
          disabled={item.isProtected}
          onChange={(event) =>
            onChange(setShown(list, item.key, event.currentTarget.checked, protectedKeys))
          }
        />
        <EditTools
          language={language}
          item={item}
          editing={editing}
          onEdit={onEdit}
          onRemove={onRemove}
        />
        <IconButton
          icon="arrowUp"
          label={t("layout.earlier", { item: item.label })}
          aria-disabled={index === 0}
          onClick={() => move(-1)}
        />
        <IconButton
          icon="arrowDown"
          label={t("layout.later", { item: item.label })}
          aria-disabled={index === list.order.length - 1}
          onClick={() => move(1)}
        />
      </span>
    </li>
  );
}

/**
 * One list of the layout as rows in their order: drag a row, or press its move buttons (the keyboard's way), and switch it
 * on or off. A protected row shows a lock and cannot be switched off.
 */
export function ItemList<K extends string>({
  language,
  title,
  items,
  list,
  protectedKeys,
  onChange,
  actions,
  editing = null,
  onEdit,
  onRemove,
}: ListProps<K>) {
  const t = useTranslator(language);
  const [drag, setDrag] = useState<K | null>(null);
  const [over, setOver] = useState<K | null>(null);
  const dragging = {
    start: setDrag,
    over: setOver,
    end: () => {
      setDrag(null);
      setOver(null);
    },
    drop: (target: K) => {
      if (drag !== null && drag !== target) {
        const next = moveTo(list, drag, list.order.indexOf(target));
        const item = items.find((entry) => entry.key === drag);
        onChange(
          next,
          t("layout.moved", {
            item: item?.label ?? "",
            position: positionOf(next, drag),
            total: next.order.length,
          }),
        );
      }
      setDrag(null);
      setOver(null);
    },
  };
  const rows = list.order
    .map((key) => items.find((entry) => entry.key === key))
    .filter((item): item is LayoutItem<K> => item !== undefined);
  return (
    <Section title={title} actions={actions}>
      <ul className={styles.items} aria-label={title}>
        {rows.map((item) => (
          <Row
            key={item.key}
            language={language}
            item={item}
            list={list}
            protectedKeys={protectedKeys}
            drag={drag}
            over={over}
            dragging={dragging}
            onChange={onChange}
            editing={editing}
            onEdit={onEdit}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </Section>
  );
}
