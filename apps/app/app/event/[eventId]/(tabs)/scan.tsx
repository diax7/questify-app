import { Redirect } from "expo-router";

/** Never shown: the center button opens the "coming soon" sheet (T-115 makes this the scanner and My QR). */
export default function ScanScreen() {
  return <Redirect href="./" />;
}
