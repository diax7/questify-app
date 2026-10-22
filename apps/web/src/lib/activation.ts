import type { MessageKey } from "@questify/shared";

/** Where an event stands with Questify (GET …/events/{id}/activation, T-210). */
export type ActivationView = Readonly<{
  state: "not_requested" | "requested" | "rejected" | "activated";
  requestedAt: string | null;
  note: string | null;
  limit: Readonly<{ mode: "none" | "soft" | "hard"; value: number | null }>;
  players: number;
  alerts: readonly number[];
  addons: readonly string[];
}>;

const STATES = new Set(["not_requested", "requested", "rejected", "activated"]);
const MODES = new Set(["none", "soft", "hard"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isNumberList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === "number");

/** Checks the API's answer, so a changed API shows the error state instead of a broken card. */
export function readActivation(value: unknown): ActivationView | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const limit = value["limit"];
  if (
    !STATES.has(String(value["state"])) ||
    !isTextOrNull(value["requestedAt"]) ||
    !isTextOrNull(value["note"]) ||
    !isRecord(limit) ||
    !MODES.has(String(limit["mode"])) ||
    !(limit["value"] === null || typeof limit["value"] === "number") ||
    typeof value["players"] !== "number" ||
    !isNumberList(value["alerts"]) ||
    !isStringList(value["addons"])
  ) {
    return undefined;
  }
  return value as ActivationView;
}

export type Line = Readonly<{
  key: MessageKey;
  params: Readonly<Record<string, string | number>>;
}>;

/** The limit as the team reads it (FR-1021). */
export function limitLine(view: ActivationView): Line {
  if (view.limit.mode === "none" || view.limit.value === null) {
    return { key: "activation.limit.none", params: {} };
  }
  const key = view.limit.mode === "hard" ? "activation.limit.hard" : "activation.limit.soft";
  return { key, params: { limit: view.limit.value } };
}

/**
 * The banner for the marks reached (FR-1021): at 100% the hard or soft wording, at 80% the count; none below, or with
 * no limit. The marks come from the database, so a banner never disagrees with what joining does.
 */
export function limitBanner(view: ActivationView): Line | undefined {
  const limit = view.limit.value;
  if (view.limit.mode === "none" || limit === null) {
    return undefined;
  }
  const params = { count: view.players, limit };
  if (view.alerts.includes(100)) {
    const key =
      view.limit.mode === "hard" ? "activation.alert.fullHard" : "activation.alert.fullSoft";
    return { key, params };
  }
  return view.alerts.includes(80) ? { key: "activation.alert.near", params } : undefined;
}

/** A known add-on's name, else its key (a feature added to the registry before its words). */
export function addonName(feature: string, t: (key: MessageKey) => string): string {
  return feature === "bigScreen" ? t("addon.bigScreen") : feature;
}
