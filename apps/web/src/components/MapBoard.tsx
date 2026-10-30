"use client";

import { MAP_LIMITS, type TeamMapPin } from "@questify/shared";
import type { MouseEvent } from "react";
import { PIN_GLYPH } from "#src/lib/maps.ts";
import styles from "#src/components/maps.module.css";

const percent = (thousandths: number): string => `${thousandths / 10}%`;

const clamp = (value: number): number =>
  Math.min(MAP_LIMITS.scale, Math.max(0, Math.round(value * MAP_LIMITS.scale)));

/** A click on the board as thousandths of its width and height; null for a key press, which has no place to name. */
function placeOf(event: MouseEvent<HTMLButtonElement>): { x: number; y: number } | null {
  if (event.detail === 0) return null;
  const box = event.currentTarget.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const across = (event.clientX - box.left) / box.width;
  const down = (event.clientY - box.top) / box.height;
  return { x: clamp(across), y: clamp(down) };
}

/**
 * The plain board of one map with its pins (T-506). A click on the board names a place (the surface is for a pointer
 * alone, out of the tab order and hidden from a screen reader; the number fields beside it are the way for a keyboard); a pin is a button that opens its form. `draft` marks where the pin being edited will
 * sit. The board is a plan, so it is never mirrored for Arabic.
 */
export function MapBoard({
  label,
  pins,
  labelOf,
  selectedId,
  draft,
  onPlace,
  onSelect,
}: Readonly<{
  label: string;
  pins: readonly TeamMapPin[];
  labelOf: (pin: TeamMapPin) => string;
  selectedId: string | null;
  draft: Readonly<{ x: number; y: number }> | null;
  onPlace: (place: { x: number; y: number }) => void;
  onSelect: (pin: TeamMapPin) => void;
}>) {
  return (
    <div className={styles.board} role="group" aria-label={label}>
      <button
        type="button"
        className={styles.surface}
        tabIndex={-1}
        aria-hidden="true"
        onClick={(event) => {
          const place = placeOf(event);
          if (place !== null) onPlace(place);
        }}
      />
      {pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          className={pin.id === selectedId ? `${styles.pin} ${styles.pinSelected}` : styles.pin}
          style={{ insetInlineStart: percent(pin.x), insetBlockStart: percent(pin.y) }}
          title={labelOf(pin)}
          aria-label={labelOf(pin)}
          aria-pressed={pin.id === selectedId}
          onClick={() => onSelect(pin)}
        >
          {PIN_GLYPH[pin.kind]}
        </button>
      ))}
      {draft === null || Number.isNaN(draft.x) || Number.isNaN(draft.y) ? null : (
        <span
          className={`${styles.pin} ${styles.pinDraft}`}
          aria-hidden="true"
          style={{ insetInlineStart: percent(draft.x), insetBlockStart: percent(draft.y) }}
        />
      )}
    </div>
  );
}
