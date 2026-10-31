import type { LayoutList } from "@questify/shared";

/** Moves an item to a place in the order (clamped to the list); anything unknown leaves the list as it was. */
export function moveTo<K extends string>(
  list: LayoutList<K>,
  key: K,
  index: number,
): LayoutList<K> {
  const from = list.order.indexOf(key);
  if (from === -1) {
    return list;
  }
  const rest = list.order.filter((item) => item !== key);
  const to = Math.min(Math.max(index, 0), rest.length);
  return { ...list, order: [...rest.slice(0, to), key, ...rest.slice(to)] };
}

/** Moves an item one place earlier (-1) or later (1). */
export function moveBy<K extends string>(list: LayoutList<K>, key: K, step: -1 | 1): LayoutList<K> {
  return moveTo(list, key, list.order.indexOf(key) + step);
}

/**
 * Shows or hides an item. A protected item is always shown: asking to hide it changes nothing (the server refuses it too,
 * FR-1750), so the editor cannot build a layout the server will turn down.
 */
export function setShown<K extends string>(
  list: LayoutList<K>,
  key: K,
  shown: boolean,
  protectedKeys: ReadonlySet<K>,
): LayoutList<K> {
  const hidden = list.hidden.filter((item) => item !== key);
  if (shown || protectedKeys.has(key)) {
    return { ...list, hidden };
  }
  return { ...list, hidden: [...hidden, key] };
}

/** Where an item stands among the whole list, counted from 1, for the words read aloud after a move. */
export function positionOf<K extends string>(list: LayoutList<K>, key: K): number {
  return list.order.indexOf(key) + 1;
}
