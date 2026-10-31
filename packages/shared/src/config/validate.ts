import { z } from "zod";
import { ACCENT_KEYS, readBranding, type AccentKey } from "#src/design/accents";
import type { ComposedConfig } from "./compose";
import type { PlatformSettings, Registries } from "./registry";
import { readComposedLayout } from "#src/layout/layout";
import { readEventTerms } from "./terms";

export type ConfigIssue = Readonly<{
  path: string;
  message: string;
  /** Set when a layout tried to hide an item that is always shown (FR-1750): the item's name. */
  protectedItem?: string;
}>;

export type Validation<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issues: readonly ConfigIssue[] }>;

const VERSION = /^[0-9]+(\.[0-9]+){1,2}$/;

const text = z.string().refine((value) => value.trim() !== "", "must not be blank");
const localized = z.strictObject({ ar: text, en: text });

const platformShape = z.strictObject({
  features: z
    .record(
      z.string(),
      z.strictObject({
        enabled: z.boolean().optional(),
        message: localized.optional(),
        minAppVersion: z.string().regex(VERSION, "must look like 1.2.3").optional(),
      }),
    )
    .optional(),
  tuning: z.record(z.string(), z.number()).optional(),
});

// An event's own config holds switches only. Unlocking an add-on is a separate admin-only record,
// because the organizer can edit this config and must not be able to unlock anything for themselves.
const eventShape = z.strictObject({
  features: z.record(z.string(), z.boolean()).optional(),
});

const pathOf = (parts: readonly PropertyKey[]): string => parts.map(String).join(".");

function issuesOf(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({ path: pathOf(issue.path), message: issue.message }));
}

function unknownFeatureIssues(registries: Registries, keys: readonly string[]): ConfigIssue[] {
  return keys
    .filter((key) => !(key in registries.features))
    .map((key) => ({ path: `features.${key}`, message: "is not a feature of the app" }));
}

/** Features Questify sets for every event at once: an event cannot switch them. */
function platformOnlyIssues(registries: Registries, keys: readonly string[]): ConfigIssue[] {
  return keys
    .filter((key) => registries.features[key]?.level === "platform")
    .map((key) => ({ path: `features.${key}`, message: "is set by Questify for every event" }));
}

function tuningIssues(
  registries: Registries,
  tuning: Readonly<Record<string, number>>,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [key, number] of Object.entries(tuning)) {
    const definition = registries.tuning[key];
    if (definition === undefined) {
      issues.push({ path: `tuning.${key}`, message: "is not a tuning number of the app" });
    } else if (!Number.isFinite(number) || number < definition.min || number > definition.max) {
      issues.push({
        path: `tuning.${key}`,
        message: `must be a number from ${definition.min} to ${definition.max}`,
      });
    }
  }
  return issues;
}

/**
 * Checks what a Questify admin wants to save. Only features and numbers the reviewed app contains are
 * accepted (FR-1504), every number must lie in its safe range, and a typo in a field name is an error.
 */
export function validatePlatformSettings(
  registries: Registries,
  input: unknown,
): Validation<PlatformSettings> {
  const parsed = platformShape.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: issuesOf(parsed.error) };
  }
  const issues = [
    ...unknownFeatureIssues(registries, Object.keys(parsed.data.features ?? {})),
    ...tuningIssues(registries, parsed.data.tuning ?? {}),
  ];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: parsed.data };
}

/** Checks what an event owner may store in the event's own config: switches for known features only. */
export function validateEventConfig(
  registries: Registries,
  input: unknown,
): Validation<{ features?: Readonly<Record<string, boolean>> | undefined }> {
  const parsed = eventShape.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: issuesOf(parsed.error) };
  }
  const keys = Object.keys(parsed.data.features ?? {});
  const issues = [
    ...unknownFeatureIssues(registries, keys),
    ...platformOnlyIssues(registries, keys),
  ];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: parsed.data };
}

const brandingShape = z.strictObject({
  accent: z.enum(ACCENT_KEYS as [AccentKey, ...AccentKey[]]).nullable(),
});

/** Checks the look an organizer saves: one accent from the curated list, or null for Questify's own colour. */
export function validateEventBranding(input: unknown): Validation<{ accent: AccentKey | null }> {
  const parsed = brandingShape.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: issuesOf(parsed.error) };
}

/** True when the app has this feature and it is an add-on that Questify can unlock for an event. */
export function isGatedFeature(registries: Registries, key: string): boolean {
  return registries.features[key]?.gated === true;
}

const composedShape = z.object({
  schemaVersion: z.literal(1),
  features: z.record(
    z.string(),
    z.object({
      enabled: z.boolean(),
      minAppVersion: z.string().nullable(),
      message: z.object({ ar: z.string(), en: z.string() }).nullable(),
    }),
  ),
  tuning: z.record(z.string(), z.number()),
  legal: z.object({ documents: z.array(z.object({ id: z.string(), version: z.string() })) }),
  // Read tolerantly: a copy saved before T-117 has none, and one bad word falls back to its default.
  terms: z.unknown().optional().transform(readEventTerms),
  // Read tolerantly too: a copy saved before T-602 has none, and an accent this app does not know shows as none.
  branding: z.unknown().optional().transform(readBranding),
  // Read tolerantly as well: a copy saved before T-606 has none, and a layout that hides a protected item falls back to Questify's.
  layout: z.unknown().optional().transform(readComposedLayout),
});

/**
 * Checks a configuration document the app received. Blocks it does not know are dropped (a newer server never
 * breaks an older app); a document it cannot read is refused so the app keeps its last working copy (F-282).
 */
export function parseComposedConfig(
  input: unknown,
): { ok: true; config: ComposedConfig } | { ok: false } {
  const parsed = composedShape.safeParse(input);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false };
}
