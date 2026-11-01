"use client";

import type { Language, MessageKey } from "@questify/shared";
import type { ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { moveWithin } from "#src/lib/home-content-editor.ts";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Card, SubHeading, Toolbar } from "#src/ui/Section.tsx";

/** The words for an entry's three buttons; each takes the entry's number as `{n}`. */
export type EntryNames = Readonly<{
  earlier: MessageKey;
  later: MessageKey;
  remove: MessageKey;
}>;

/** Move earlier, move later and remove, for one entry of a list (a slide, a link, a question, a part of the page). */
function EntryTools({
  language,
  names,
  n,
  last,
  onMove,
  onRemove,
}: Readonly<{
  language: Language;
  names: EntryNames;
  n: number;
  last: boolean;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Toolbar>
      <IconButton
        icon="arrowUp"
        label={t(names.earlier, { n })}
        disabled={n === 1}
        onClick={() => onMove(-1)}
      />
      <IconButton
        icon="arrowDown"
        label={t(names.later, { n })}
        disabled={last}
        onClick={() => onMove(1)}
      />
      <IconButton icon="trash" label={t(names.remove, { n })} onClick={() => onRemove()} />
    </Toolbar>
  );
}

/**
 * A list of entries with the same editor each, with move and remove on every entry. `footer` holds the buttons that add one;
 * it is drawn while the list is under its limit.
 */
export function EntryList<T>({
  language,
  entries,
  limit,
  heading,
  names,
  footer,
  onChange,
  children,
}: Readonly<{
  language: Language;
  entries: readonly T[];
  limit: number;
  heading: (entry: T, n: number) => string;
  names: EntryNames;
  footer: ReactNode;
  onChange: (next: T[]) => void;
  children: (entry: T, replace: (next: T) => void) => ReactNode;
}>) {
  return (
    <>
      {entries.map((entry, index) => (
        // The entries have no id and keep their order, so the position is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        <Card key={index} as="section" aria-label={heading(entry, index + 1)}>
          <SubHeading>{heading(entry, index + 1)}</SubHeading>
          {children(entry, (next) =>
            onChange(entries.map((item, position) => (position === index ? next : item))),
          )}
          <EntryTools
            language={language}
            names={names}
            n={index + 1}
            last={index === entries.length - 1}
            onMove={(step) => onChange(moveWithin(entries, index, step))}
            onRemove={() => onChange(entries.filter((_item, position) => position !== index))}
          />
        </Card>
      ))}
      {entries.length < limit ? <Toolbar>{footer}</Toolbar> : null}
    </>
  );
}
