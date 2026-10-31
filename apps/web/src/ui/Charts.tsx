"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import styles from "#src/ui/charts.module.css";
import { ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import { nameInfo } from "#src/ui/name-info.ts";

/**
 * Analytics figures and charts (T-607, ADR-392). Plain HTML and SVG, no chart library: one data colour from the theme,
 * thin marks, a hairline grid and the value at the end of every bar. A chart never leaves a value to colour alone, and
 * every value its hover shows is also on the page (a label, a row or the "View more" list).
 */

/**
 * A grid of equal cards. `tiles` are the small figure tiles, `panels` the larger cards (two across where the page has the
 * room); the cards of one row are as tall as the tallest.
 */
export function PanelGrid({
  kind = "panels",
  children,
}: Readonly<{ kind?: "tiles" | "panels"; children: ReactNode }>) {
  return <div className={kind === "tiles" ? styles.tiles : styles.panels}>{children}</div>;
}

/** A card that takes the whole row of a `panels` grid. */
export function WideCard({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={`${styles.wide} ${styles.panels}`}>{children}</div>;
}

/** One figure under its name: the name is the tile's heading, `info` an `InfoTip` beside it (ADR-370). */
export function Tile({
  title,
  info,
  children,
}: Readonly<{ title: string; info?: ReactNode; children: ReactNode }>) {
  const id = useId();
  return (
    <section className={styles.tile} aria-labelledby={id}>
      <div className={styles.tileLabel}>
        <h3 id={id} className={styles.tileTitle}>
          {title}
        </h3>
        {nameInfo(info, title)}
      </div>
      {children}
    </section>
  );
}

/** The number of a tile. */
export function Figure({ children }: Readonly<{ children: ReactNode }>) {
  return <p className={styles.figure}>{children}</p>;
}

export type BarRow = Readonly<{
  key: string;
  label: ReactNode;
  /** The value at the end of the row, as text. */
  value: ReactNode;
  /** The bar's length from 0 to 1. */
  share: number;
  /** A word beside the label (the largest drop), so a mark is never told by colour alone. */
  flag?: ReactNode;
  /** A line under the bar. */
  meta?: ReactNode;
}>;

/** Horizontal bars from the start edge, 10px thick with a 4px rounded end, each with its value in words and digits. */
export function BarRows({ rows }: Readonly<{ rows: readonly BarRow[] }>) {
  return (
    <ul className={styles.bars}>
      {rows.map((row) => {
        const share = Math.max(0, Math.min(1, row.share));
        return (
          <li key={row.key} className={styles.bar}>
            <div className={styles.barHead}>
              <span className={styles.barLabel}>
                {row.label}
                {row.flag}
              </span>
              <span className={styles.barValue}>{row.value}</span>
            </div>
            <div className={styles.track} aria-hidden="true">
              <div
                className={styles.fill}
                style={
                  share === 0
                    ? { inlineSize: 0 }
                    : { inlineSize: `${share * 100}%`, minInlineSize: "4px" }
                }
              />
            </div>
            {row.meta === undefined ? null : <span className={styles.barMeta}>{row.meta}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export type ChartPoint = Readonly<{
  /** Where the point sits on the time axis. */
  x: number;
  value: number;
  /** The time in full, for the readout. */
  label: string;
  /** The time in short, for the ends of the axis. */
  short: string;
}>;

const geometryOf = (points: readonly ChartPoint[], top: number) => {
  const first = points[0]?.x ?? 0;
  const span = (points.at(-1)?.x ?? 0) - first;
  const xs = points.map((point) => (span === 0 ? 50 : ((point.x - first) / span) * 100));
  const ys = points.map((point) => 100 - (point.value / top) * 100);
  const line = points
    .map((_, index) => `${index === 0 ? "M" : "L"}${xs[index]} ${ys[index]}`)
    .join(" ");
  return { xs, ys, line, wash: `${line} L${xs.at(-1) ?? 0} 100 L${xs[0] ?? 0} 100 Z` };
};

/**
 * Which point the readout is on: the nearest to the pointer, or the one the arrow keys, Home and End moved to. `null`
 * while neither hovers nor focuses the plot, when the end of the line is shown without a readout.
 */
function useReadout(xs: readonly number[]) {
  const [active, setActive] = useState<number | null>(null);
  const last = xs.length - 1;
  const shown = active ?? last;
  const handlers = {
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      const at = ((event.clientX - box.left) / Math.max(1, box.width)) * 100;
      let best = 0;
      for (const [index, position] of xs.entries()) {
        if (Math.abs(position - at) < Math.abs((xs[best] ?? 0) - at)) {
          best = index;
        }
      }
      setActive(best);
    },
    onPointerLeave: () => setActive(null),
    onFocus: () => setActive(last),
    onBlur: () => setActive(null),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const moves: Readonly<Record<string, number>> = {
        ArrowLeft: Math.max(0, shown - 1),
        ArrowDown: Math.max(0, shown - 1),
        ArrowRight: Math.min(last, shown + 1),
        ArrowUp: Math.min(last, shown + 1),
        Home: 0,
        End: last,
      };
      const next = moves[event.key];
      if (next !== undefined) {
        event.preventDefault();
        setActive(next);
      } else if (event.key === "Escape") {
        setActive(null);
      }
    },
  };
  return { active, shown, handlers };
}

/** The crosshair and the readout beside it, value first, on the side of the crosshair that has room. */
function Readout({
  point,
  x,
  format,
}: Readonly<{ point: ChartPoint; x: number; format: (value: number) => string }>) {
  return (
    <>
      <span className={styles.cross} style={{ insetInlineStart: `${x}%` }} />
      <span
        className={styles.tip}
        style={{
          insetInlineStart: `${x}%`,
          transform: x > 60 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
        }}
      >
        <span className={styles.tipValue}>{format(point.value)}</span>
        <span className={styles.tipTime} dir="auto">
          {point.label}
        </span>
      </span>
      <span role="status">
        <ScreenReaderOnly>{`${point.label}: ${format(point.value)}`}</ScreenReaderOnly>
      </span>
    </>
  );
}

/** The grid, the wash and the line, drawn on a 100 by 100 plot that stretches to its box. */
function Plot({
  ticks,
  top,
  line,
  wash,
}: Readonly<{ ticks: readonly number[]; top: number; line: string; wash: string }>) {
  return (
    <svg
      className={styles.plot}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {ticks.map((tick) => (
        <line
          key={tick}
          className={styles.gridLine}
          x1="0"
          x2="100"
          y1={100 - (tick / top) * 100}
          y2={100 - (tick / top) * 100}
        />
      ))}
      <path className={styles.wash} d={wash} />
      <path className={styles.line} d={line} />
    </svg>
  );
}

/** The first and the last time of the line, under its ends. */
function TimeAxis({ points }: Readonly<{ points: readonly ChartPoint[] }>) {
  return (
    <div className={styles.xAxis}>
      <span dir="auto">{points[0]?.short}</span>
      {points.length > 1 ? <span dir="auto">{points.at(-1)?.short}</span> : null}
    </div>
  );
}

/**
 * A line with a 10% wash under it (a running count), 2px thick, with a dot on the point read out (the end of the line
 * until a pointer or the keyboard moves it). Hovering or focusing the plot and pressing the arrow keys, Home or End moves
 * a crosshair to the nearest point and reads it out, value first. The time runs from left to right in both languages.
 */
export function LineChart({
  points,
  ticks,
  name,
  format,
}: Readonly<{
  points: readonly ChartPoint[];
  /** The axis' values from 0 up; the last is the top of the plot. */
  ticks: readonly number[];
  /** What the chart shows, for a screen reader. */
  name: string;
  format: (value: number) => string;
}>) {
  const top = ticks.at(-1) ?? 1;
  const { xs, ys, line, wash } = geometryOf(points, top);
  const { active, shown, handlers } = useReadout(xs);
  const point = points[shown];
  if (point === undefined) {
    return null;
  }
  const x = xs[shown] ?? 0;
  return (
    <div className={styles.chart} dir="ltr">
      <div className={styles.yAxis} aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick} className={styles.yTick}>
            {format(tick)}
          </span>
        ))}
      </div>
      <div className={styles.area} role="group" aria-label={name} tabIndex={0} {...handlers}>
        <Plot ticks={ticks} top={top} line={line} wash={wash} />
        <span
          className={styles.dot}
          style={{ insetInlineStart: `${x}%`, insetBlockStart: `${ys[shown] ?? 0}%` }}
        />
        {active === null ? null : <Readout point={point} x={x} format={format} />}
      </div>
      <TimeAxis points={points} />
    </div>
  );
}
