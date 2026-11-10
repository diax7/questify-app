import { BalooBhaijaan2_700Bold } from "@expo-google-fonts/baloo-bhaijaan-2/700Bold";
import { BalooBhaijaan2_800ExtraBold } from "@expo-google-fonts/baloo-bhaijaan-2/800ExtraBold";
import { Rubik_400Regular } from "@expo-google-fonts/rubik/400Regular";
import { Rubik_600SemiBold } from "@expo-google-fonts/rubik/600SemiBold";
import type { FontName } from "#src/theme/font-faces.ts";

/**
 * The web build ships the four files the design uses (T-803): Baloo Bhaijaan 2 at 800 (display) and 700 (title), Rubik at
 * 400 (body) and 600 (label). A name the table can ask for but the design never does takes the closest of the four, the
 * same rule `fontFor` uses, so a theme that asks for another weight still draws in the family and the browser downloads
 * four files, not eight.
 */
export const FONT_FILES = {
  BalooBhaijaan2_500Medium: BalooBhaijaan2_700Bold,
  BalooBhaijaan2_600SemiBold: BalooBhaijaan2_700Bold,
  BalooBhaijaan2_700Bold,
  BalooBhaijaan2_800ExtraBold,
  Rubik_400Regular,
  Rubik_500Medium: Rubik_600SemiBold,
  Rubik_600SemiBold,
  Rubik_700Bold: Rubik_600SemiBold,
} satisfies Record<FontName, unknown>;
