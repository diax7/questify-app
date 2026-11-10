import { browser, type BrowserGlobals } from "#src/platform/browser.ts";

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
 * The browser's version of `Alert.alert`, which does nothing on react-native-web (T-803). The same title, message and
 * buttons: a cancel button and an action become `window.confirm`; a message alone, or one button, becomes
 * `window.alert` and then runs that button. With several actions the first one is OK's. With two or more buttons and none
 * styled cancel, the last one stands in as the cancel, so an action never runs unasked.
 */
export function webAlert(
  title: string,
  message: string | undefined,
  buttons: readonly AlertButton[] | undefined,
  env: Dialogs = browser(),
): void {
  const all = buttons ?? [];
  // Two buttons and none styled cancel: the last one is still the way out, so the player is asked first.
  const cancel =
    all.find((button) => button.style === "cancel") ??
    (all.length >= 2 ? all[all.length - 1] : undefined);
  const [action] = all.filter((button) => button !== cancel);
  if (action === undefined || cancel === undefined) {
    inform(textOf(title, message), action, env);
  } else {
    ask(textOf(title, message), action, cancel, env);
  }
}
