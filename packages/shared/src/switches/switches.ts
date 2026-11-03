import { z } from "zod";
import type {
  FeatureDefinition,
  PlatformFeatureSetting,
  PlatformSettings,
  Registries,
  TuningDefinition,
} from "#src/config/registry";

/** A message shown to players while a feature is off: both languages or none. */
export const messageSchema = z.strictObject({
  ar: z.string().trim().min(1).max(300),
  en: z.string().trim().min(1).max(300),
});

/** The body that saves one platform feature switch (T-703, FR-1769): on or off, with the message only while off. */
export const featureSwitchBodySchema = z
  .strictObject({ enabled: z.boolean(), message: messageSchema.nullable() })
  .refine((body) => !body.enabled || body.message === null, {
    path: ["message"],
    message: "a message belongs to a switched-off feature",
  });
export type FeatureSwitchBody = z.infer<typeof featureSwitchBodySchema>;

/** The body that saves one tuning number (T-703, FR-1770). The range is checked against the registry. */
export const tuningBodySchema = z.strictObject({ value: z.number().int() });
export type TuningBody = z.infer<typeof tuningBodySchema>;

const featureRowSchema = z.strictObject({
  key: z.string(),
  /** Set by Questify for every event at once; otherwise an event's owner may narrow it for the event. */
  platformOnly: z.boolean(),
  /** An add-on: off for an event until Questify unlocks it. */
  addOn: z.boolean(),
  /** What the platform switch is now (the default where nothing is stored). */
  enabled: z.boolean(),
  /** The switch the app ships with, and what reset returns to. */
  defaultEnabled: z.boolean(),
  changed: z.boolean(),
  message: messageSchema.nullable(),
});

const tuningRowSchema = z.strictObject({
  key: z.string(),
  value: z.number(),
  default: z.number(),
  min: z.number(),
  max: z.number(),
  changed: z.boolean(),
  /** Read by the server only; the app never receives it. */
  serverOnly: z.boolean(),
});

/** What `GET /v1/admin/switches` answers: every feature and every tuning number of the app with its state. */
export const switchesViewSchema = z.strictObject({
  features: z.array(featureRowSchema),
  tuning: z.array(tuningRowSchema),
});
export type SwitchesView = z.infer<typeof switchesViewSchema>;
export type FeatureRow = z.infer<typeof featureRowSchema>;
export type TuningRow = z.infer<typeof tuningRowSchema>;

const byKey = <T extends { key: string }>(a: T, b: T): number => (a.key < b.key ? -1 : 1);

function featureRowOf(
  key: string,
  definition: FeatureDefinition,
  setting: PlatformFeatureSetting | undefined,
): FeatureRow {
  const defaultEnabled = definition.offByDefault !== true;
  const enabled = setting?.enabled ?? defaultEnabled;
  return {
    key,
    platformOnly: definition.level === "platform",
    addOn: definition.gated,
    enabled,
    defaultEnabled,
    changed: enabled !== defaultEnabled,
    message: enabled ? null : (setting?.message ?? null),
  };
}

/** A stored number counts only when every reader would use it: whole and inside the range. */
const isUsable = (number: number | undefined, definition: TuningDefinition): number is number =>
  number !== undefined &&
  Number.isInteger(number) &&
  number >= definition.min &&
  number <= definition.max;

function tuningRowOf(
  key: string,
  definition: TuningDefinition,
  stored: number | undefined,
): TuningRow {
  const usable = isUsable(stored, definition);
  return {
    key,
    value: usable ? stored : definition.default,
    default: definition.default,
    min: definition.min,
    max: definition.max,
    changed: usable && stored !== definition.default,
    serverOnly: definition.serverOnly === true,
  };
}

/**
 * The console's view of the stored platform settings against what the app has. A stored number outside its range is
 * shown as the default, since that is what every reader uses (`composeConfig`, the database functions).
 */
export function buildSwitchesView(registries: Registries, stored: PlatformSettings): SwitchesView {
  return {
    features: Object.entries(registries.features)
      .map(([key, definition]) => featureRowOf(key, definition, stored.features?.[key]))
      .sort(byKey),
    tuning: Object.entries(registries.tuning)
      .map(([key, definition]) => tuningRowOf(key, definition, stored.tuning?.[key]))
      .sort(byKey),
  };
}
