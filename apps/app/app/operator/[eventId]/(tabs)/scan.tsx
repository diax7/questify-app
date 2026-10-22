import { Redirect } from "expo-router";

/**
 * Never shown: the `scan` tab owns the round button in the bar, which opens the station scanner
 * (`../station-scan.tsx`) over the tabs. Removing this file would remove the button.
 */
export default function OperatorScanTab() {
  return <Redirect href="./" />;
}
