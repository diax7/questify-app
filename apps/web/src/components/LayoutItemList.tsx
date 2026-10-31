"use client";

import type { Language, LayoutList } from "@questify/shared";
import { useState, type DragEvent } from "react";
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
}>;

type ListProps<K extends string> = Readonly<{
  language: Language;
  title: string;
  items: readonly LayoutItem<K>[];
  list: LayoutList<K>;
  protectedKeys: ReadonlySet<K>;
  /** The new list, and the words a screen reader hears after a move. */
  onChange: (next: LayoutList<K>, spoken?: string) => void;
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
}>;

function Row<K extends string>({
  language,
  item,
  list,
  protectedKeys,
  drag,
  over,
  dragging,
  onChange,
}: RowProps<K>) {
  const t = useTranslator(language);
  const index = list.order.indexOf(item.key);
  const move = (step: -1 | 1) => {
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
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.key);
    dragging.start(item.key);
  };
  const onDragOver = (event: DragEvent) => {
    if (drag !== null) {
      event.preventDefault();
      dragging.over(item.key);
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragging.drop(item.key);
  };
  return (
    <li
      className={styles.item}
      data-dragging={drag === item.key}
      data-over={over === item.key && drag !== item.key}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
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
        <IconButton
          icon="arrowUp"
          label={t("layout.earlier", { item: item.label })}
          disabled={index === 0}
          onClick={() => move(-1)}
        />
        <IconButton
          icon="arrowDown"
          label={t("layout.later", { item: item.label })}
          disabled={index === list.order.length - 1}
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
    <Section title={title}>
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
          />
        ))}
      </ul>
    </Section>
  );
}
