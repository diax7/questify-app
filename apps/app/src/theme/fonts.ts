import { BalooBhaijaan2_500Medium } from "@expo-google-fonts/baloo-bhaijaan-2/500Medium";
import { BalooBhaijaan2_600SemiBold } from "@expo-google-fonts/baloo-bhaijaan-2/600SemiBold";
import { BalooBhaijaan2_700Bold } from "@expo-google-fonts/baloo-bhaijaan-2/700Bold";
import { BalooBhaijaan2_800ExtraBold } from "@expo-google-fonts/baloo-bhaijaan-2/800ExtraBold";
import { Rubik_400Regular } from "@expo-google-fonts/rubik/400Regular";
import { Rubik_500Medium } from "@expo-google-fonts/rubik/500Medium";
import { Rubik_600SemiBold } from "@expo-google-fonts/rubik/600SemiBold";
import { Rubik_700Bold } from "@expo-google-fonts/rubik/700Bold";
import type { FontName } from "#src/theme/font-faces.ts";

/**
 * The font files shipped inside the app, keyed by the names in FONT_FACES (font-faces.ts). Each weight is imported from
 * its own path: the package's index would pull in every weight and italic (88 files), and the web build would ship them all.
 */
export const FONT_FILES = {
  BalooBhaijaan2_500Medium,
  BalooBhaijaan2_600SemiBold,
  BalooBhaijaan2_700Bold,
  BalooBhaijaan2_800ExtraBold,
  Rubik_400Regular,
  Rubik_500Medium,
  Rubik_600SemiBold,
  Rubik_700Bold,
} satisfies Record<FontName, unknown>;
