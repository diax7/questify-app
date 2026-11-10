import { Platform } from "react-native";
import { CAPABILITIES, platformOf } from "#src/platform/capabilities.ts";

/** The platform this bundle runs on and what it offers. Read once: it never changes while the app runs. */
export const platform = platformOf(Platform.OS);
export const capabilities = CAPABILITIES[platform];
