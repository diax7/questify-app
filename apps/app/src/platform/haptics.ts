/**
 * The one door to `expo-haptics` (T-803). Screens import this file, never the package, so the web bundle takes
 * `haptics.web.ts` (a no-op) and never loads the native module. The names are the package's own.
 */
export {
  ImpactFeedbackStyle,
  NotificationFeedbackType,
  impactAsync,
  notificationAsync,
} from "expo-haptics";
