/**
 * The browser has no haptics (vibration is blocked before a tap and iOS has none), so every call does nothing. Same
 * names and values as `expo-haptics`, so the calling code is the same on every platform.
 */
export const ImpactFeedbackStyle = {
  Light: "light",
  Medium: "medium",
  Heavy: "heavy",
  Rigid: "rigid",
  Soft: "soft",
} as const;
export type ImpactFeedbackStyle = (typeof ImpactFeedbackStyle)[keyof typeof ImpactFeedbackStyle];

export const NotificationFeedbackType = {
  Success: "success",
  Warning: "warning",
  Error: "error",
} as const;
export type NotificationFeedbackType =
  (typeof NotificationFeedbackType)[keyof typeof NotificationFeedbackType];

export const impactAsync = (_style?: ImpactFeedbackStyle): Promise<void> => Promise.resolve();

export const notificationAsync = (_type?: NotificationFeedbackType): Promise<void> =>
  Promise.resolve();
