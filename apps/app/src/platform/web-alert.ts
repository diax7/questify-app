import { browser, type BrowserGlobals } from "#src/platform/browser.ts";
import { dialogs } from "#src/platform/dialog-queue.ts";

/** One button of a confirmation, the same shape `Alert.alert` takes. */
export type AlertButton = Readonly<{
  text: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
}>;

type Dialogs = Pick<BrowserGlobals, "alert" | "confirm">;

const textOf = (title: string, message: string | undefined): string =>
  message === undefined || message === "" ? title : `${title}\n\n${message}`;

/** A message the player only reads: `window.alert`, then the one button's own handler. */
function inform(text: string, action: AlertButton | undefined, env: Dialogs): void {
  env.alert?.(text);
  action?.onPress?.();
}

/** A question: OK runs the action, Cancel runs the cancel button's own handler. */
function ask(text: string, action: AlertButton, cancel: AlertButton | undefined, env: Dialogs) {
  const chosen = env.confirm?.(text) === true ? action : cancel;
  chosen?.onPress?.();
}

/**
 * The browser's version of `Alert.alert`, which does nothing on react-native-web (T-803). With the app's own dialog on
 * screen (`AlertHost`, mounted by the root layout) every button is shown and the player taps one, so a browser that
 * blocks `window.confirm` cannot cancel an action silently. Without it (before the first screen) the same title, message
 * and buttons go to the browser: a cancel button and an action become `window.confirm`; a message alone, or one button, becomes
 * `window.alert` and then runs that button. With several actions the first one is OK's. With two or more buttons and none
 * styled cancel, the last one stands in as the cancel, so an action never runs unasked.
 */
export function webAlert(
  title: string,
  message: string | undefined,
  buttons: readonly AlertButton[] | undefined,
  env: Dialogs = browser(),
  queue: Pick<typeof dialogs, "present"> = dialogs,
): void {
  const all = buttons ?? [];
  if (!queue.present({ title, message, buttons: all })) {
    viaBrowser(textOf(title, message), all, env);
  }
}

/** With no dialog host on screen: the browser's own dialogs. */
function viaBrowser(text: string, all: readonly AlertButton[], env: Dialogs): void {
  // Two buttons and none styled cancel: the last one is still the way out, so the player is asked first.
  const cancel =
    all.find((button) => button.style === "cancel") ??
    (all.length >= 2 ? all[all.length - 1] : undefined);
  const [action] = all.filter((button) => button !== cancel);
  if (action === undefined || cancel === undefined) {
    inform(text, action, env);
  } else {
    ask(text, action, cancel, env);
  }
}
