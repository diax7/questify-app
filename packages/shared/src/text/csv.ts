/**
 * One cell of a CSV a team member opens in a spreadsheet: quoted when it holds a delimiter, a quote or a line break,
 * and a text that starts like a formula (`=`, `+`, `-`, `@`) or with any whitespace (a space, tab, carriage return or
 * line feed, which a spreadsheet may skip before reading a formula) gets a leading apostrophe so the spreadsheet reads
 * it as text.
 */
export function csvCell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value.replace(/^[\s=+\-@]/u, "'$&");
  return /[",;\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows as CSV lines, each ended by a line break; a file is written in pieces of these. */
export function csvLines(rows: readonly (readonly (string | number)[])[]): string {
  const lineBreak = String.fromCharCode(13, 10);
  return rows.map((row) => row.map((value) => csvCell(value)).join(",") + lineBreak).join("");
}

/** A CSV file as text: a byte-order mark first so Excel reads Arabic, then one line a row. */
export function csvFile(rows: readonly (readonly (string | number)[])[]): string {
  return `﻿${csvLines(rows)}`;
}
