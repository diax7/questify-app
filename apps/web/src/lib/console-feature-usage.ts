import {
  featureUsagePageSchema,
  type FeatureUsagePage,
  type FeatureUsageRow,
  type MessageKey,
} from "@questify/shared";

/** The console's per-organizer feature usage (T-714, FR-1839): one page of organizers, read with a search and a cursor. */
export const FEATURE_USAGE_API = "/v1/admin/feature-usage";

/** The address of a page for a search and a cursor; empty parts are left out. */
export function featureUsagePath(query: Readonly<{ q: string; cursor: string | null }>): string {
  const params = new URLSearchParams();
  if (query.q.trim() !== "") {
    params.set("q", query.q.trim());
  }
  if (query.cursor !== null) {
    params.set("cursor", query.cursor);
  }
  const search = params.toString();
  return search === "" ? FEATURE_USAGE_API : `${FEATURE_USAGE_API}?${search}`;
}

/** Answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readFeatureUsagePage(body: unknown): FeatureUsagePage | undefined {
  const parsed = featureUsagePageSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Why a feature is off or odd for the organizer, as a message: Questify's override (on or off) over the platform, else
 * that the platform switched it off for everyone; nothing while the feature simply follows a platform that leaves it on.
 */
export function causeKeyOf(row: FeatureUsageRow): MessageKey | null {
  if (row.override !== null) {
    return row.override ? "console.organizer.features.nowOn" : "console.organizer.features.nowOff";
  }
  return row.platformEnabled ? null : "console.organizer.features.platformOff";
}

/** The line under a feature that is on: where the events have it (an add-on: where Questify unlocked it) and how many use it. */
export function usageKeysOf(row: FeatureUsageRow): Readonly<{
  line: MessageKey;
  use: MessageKey | null;
}> {
  const line = row.addOn ? "console.featureUsage.lineAddOn" : "console.featureUsage.line";
  if (row.eventsUsing === null) {
    return { line, use: null };
  }
  return {
    line,
    use: row.eventsUsing === 0 ? "console.featureUsage.noUse" : "console.featureUsage.used",
  };
}

/** How many features of the organizer are on, for the card's summary. */
export const featuresOn = (features: readonly FeatureUsageRow[]): number =>
  features.filter((row) => row.effective).length;
