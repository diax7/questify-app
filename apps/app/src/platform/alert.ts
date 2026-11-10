import { Alert, Platform } from "react-native";
import { webAlert, type AlertButton } from "#src/platform/web-alert.ts";

export type { AlertButton };

/**
 * The one confirmation the app uses (T-803): the system alert on a phone, `window.confirm` in the browser, where
 * `Alert.alert` does nothing. The title, message and buttons are the ones `Alert.alert` takes, so a screen keeps its texts.
 */
export function showAlert(title: string, message?: string, buttons?: readonly AlertButton[]): void {
  if (Platform.OS === "web") {
    webAlert(title, message, buttons);
    return;
  }
  Alert.alert(title, message, buttons === undefined ? undefined : [...buttons]);
}
