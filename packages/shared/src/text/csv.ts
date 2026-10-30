/**
 * One cell of a CSV a team member opens in a spreadsheet: quoted when it holds a delimiter, a quote or a line break,
 * and a text that starts like a formula (`=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe so
 * the spreadsheet reads it as text.
 */
export function csvCell(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value.replace(/^[=+\-@\t\r]/u, "'$&");
  return /[",;\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A CSV file as text: a byte-order mark first so Excel reads Arabic, then one line a row. */
export function csvFile(rows: readonly (readonly (string | number)[])[]): string {
  const lines = rows.map((row) => row.map((value) => csvCell(value)).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
