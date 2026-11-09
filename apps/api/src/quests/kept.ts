/** What was sent, else what is stored, else the default (a null counts as left out). */
export const keptOr = <T>(sent: T | undefined, stored: T | undefined, fallback: T): T =>
  sent ?? stored ?? fallback;

/** What was sent, null included, else what is kept. */
export const sentOrKept = <T>(sent: T | undefined, kept: T): T =>
  sent === undefined ? kept : sent;
