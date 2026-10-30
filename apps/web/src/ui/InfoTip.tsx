"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "#src/ui/Icon.tsx";
import styles from "#src/ui/infotip.module.css";

/** The space between the icon and the explanation, and the space kept between the explanation and the window's edge. */
const GAP = 6;
const EDGE = 8;

/**
 * An info button beside a label (ADR-370): the explanation shows on hover, on keyboard focus and on a tap or click, and
 * Escape, a tap elsewhere or scrolling closes it. It is for a feature or field that truly needs explaining; a line that
 * only repeats its label is cut instead. `label` names the button in the page's language; the explanation is read as
 * the button's description.
 */
export function InfoTip({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const open = hovered || focused || pinned;

  useLayoutEffect(() => {
    const trigger = wrapper.current;
    const tip = bubble.current;
    if (!open || trigger === null || tip === null) {
      return;
    }
    const anchor = trigger.getBoundingClientRect();
    const center = anchor.left + anchor.width / 2 - tip.offsetWidth / 2;
    const left = Math.min(Math.max(center, EDGE), window.innerWidth - tip.offsetWidth - EDGE);
    const fitsBelow = anchor.bottom + GAP + tip.offsetHeight <= window.innerHeight - EDGE;
    tip.style.left = `${left}px`;
    tip.style.top = `${fitsBelow ? anchor.bottom + GAP : Math.max(EDGE, anchor.top - GAP - tip.offsetHeight)}px`;
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => {
      setHovered(false);
      setFocused(false);
      setPinned(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !wrapper.current?.contains(event.target)) {
        close();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <span
      ref={wrapper}
      className={styles.wrapper}
      onPointerEnter={(event) => setHovered(event.pointerType === "mouse")}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-describedby={id}
        onClick={() => setPinned((now) => !now)}
        onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
        onBlur={(event) => {
          if (!wrapper.current?.contains(event.relatedTarget)) {
            setFocused(false);
            setPinned(false);
          }
        }}
      >
        <Icon name="info" />
      </button>
      <span id={id} ref={bubble} role="tooltip" hidden={!open} className={styles.bubble}>
        {children}
      </span>
    </span>
  );
}
