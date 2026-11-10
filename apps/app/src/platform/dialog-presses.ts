import type { AlertButton } from "#src/platform/web-alert.ts";

/**
 * What the dialog shows and what the shade and the back key do. A dialog with no buttons gets one `closeLabel` button;
 * the cancel button (the one styled `cancel`) is what a dismissal runs, and a dialog with no cancel button just closes.
 * The destructive action is never the dismissal.
 */
export function dialogPresses(
  buttons: readonly AlertButton[],
  closeLabel: string,
): Readonly<{ buttons: readonly AlertButton[]; dismiss: AlertButton | undefined }> {
  const shown = buttons.length === 0 ? [{ text: closeLabel }] : buttons;
  return { buttons: shown, dismiss: shown.find((button) => button.style === "cancel") };
}
