"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "#src/ui/Icon.tsx";
import styles from "#src/ui/infotip.module.css";

/** The space between the icon and the explanation, and the space kept between the explanation and the window's edge. */
const GAP = 6;
const EDGE = 8;

/** Puts the explanation under its button, or above it when there is no room, and inside the window sideways. */
function placeBubble(trigger: HTMLElement, tip: HTMLElement): void {
  const anchor = trigger.getBoundingClientRect();
  const center = anchor.left + anchor.width / 2 - tip.offsetWidth / 2;
  const left = Math.min(Math.max(center, EDGE), window.innerWidth - tip.offsetWidth - EDGE);
  const fitsBelow = anchor.bottom + GAP + tip.offsetHeight <= window.innerHeight - EDGE;
  const top = fitsBelow ? anchor.bottom + GAP : Math.max(EDGE, anchor.top - GAP - tip.offsetHeight);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/**
 * An info button beside a label (ADR-370): the explanation shows on hover, on keyboard focus and on a tap or click, and
 * Escape, a click on the open button or a tap elsewhere closes it; scrolling closes it too, except while keyboard focus
 * holds it open, when it follows the button. It is for a feature or field that truly needs explaining; a line that
 * only repeats its label is cut instead. `label` names the button in the page's language and `subject` is the label it
 * sits beside, so a page of them reads "More information: Name" for each; the explanation is read as the button's
 * description.
 */
export function InfoTip({
  label,
  subject,
  children,
}: Readonly<{ label: string; subject?: string; children: ReactNode }>) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const open = hovered || focused || pinned;
  const keyboardOnly = focused && !hovered && !pinned;

  const place = useCallback(() => {
    if (wrapper.current !== null && bubble.current !== null) {
      placeBubble(wrapper.current, bubble.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (open) {
      place();
    }
  }, [open, place]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => {
      setHovered(false);
      setFocused(false);
      setPinned(false);
    };
    const onScroll = () => {
      if (keyboardOnly) {
        place();
      } else {
        close();
      }
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
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, keyboardOnly, place]);

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
        aria-label={subject === undefined ? label : `${label}: ${subject}`}
        aria-describedby={id}
        onClick={() => {
          setHovered(false);
          setFocused(false);
          setPinned(!open);
        }}
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
