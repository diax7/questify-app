import { Redirect } from "expo-router";

/**
 * Never shown: the `scan` tab owns the round button in the bar, which opens the scanner (`../scan-quest.tsx`) over
 * the tabs instead of this screen. Removing this file would remove the button.
 */
export default function ScanTab() {
  return <Redirect href="./" />;
}
