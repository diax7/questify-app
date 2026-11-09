import type { TextVariant } from "@questify/shared";

/** The AppText props a line may carry; absent means the prop is not passed at all. */
export type LineProps = Readonly<{
  variant?: TextVariant;
  muted?: boolean;
  accessibilityRole?: "alert";
  accessibilityLiveRegion?: "polite";
}>;

/** One line of text a screen shows, worked out away from the JSX. `key` is stable per kind of line. */
export type TextLine = Readonly<{ key: string; text: string; props: LineProps }>;
