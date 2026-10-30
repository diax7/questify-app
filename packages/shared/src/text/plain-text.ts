import { z } from "zod";

/** Whether the text holds a control character (a line break is allowed when `multiline`). */
function hasControl(text: string, multiline: boolean): boolean {
  return Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 32 && !(multiline && code === 10)) || (code >= 127 && code < 160);
  });
}

/** Text an organizer types: trimmed, at most `max` characters, no control characters (a line break only when asked). */
export const plainText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((text) => !hasControl(text, multiline));

/** As `plainText`, and the field may be left out or null. */
export const optionalPlainText = (max: number, multiline = false) =>
  plainText(max, multiline).nullable().optional();
