import type { Language, OfficialRules } from "@questify/shared";

/** The answer of `GET /v1/public/events/{code}/rules` (FR-1707, ADR-165), or why there is none. */
export type RulesResult =
  | Readonly<{ kind: "found"; rules: OfficialRules }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "throttled" }>
  | Readonly<{ kind: "unavailable" }>;

const CODE = /^[A-Za-z0-9]{4,12}$/;

const isLines = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((line) => typeof line === "string");
const isText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** Reads the rules answer; undefined when it is not one. */
export function readRules(body: unknown): OfficialRules | undefined {
  const rules =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["rules"]
      : undefined;
  if (typeof rules !== "object" || rules === null) {
    return undefined;
  }
  const { block, text } = rules as Record<string, unknown>;
  const blockOk =
    block === null ||
    (typeof block === "object" &&
      isLines((block as Record<string, unknown>)["ar"]) &&
      isLines((block as Record<string, unknown>)["en"]));
  const textOk =
    typeof text === "object" &&
    text !== null &&
    isText((text as Record<string, unknown>)["ar"]) &&
    isText((text as Record<string, unknown>)["en"]);
  return blockOk && textOk ? (rules as OfficialRules) : undefined;
}

export type RulesRequest = Readonly<{
  apiOrigin: string;
  code: string;
  /** The browser's chain, so the API counts a wrong code against the visitor, not this server. */
  forwardedFor: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

/** Reads one event's official rules by its code. Server to server, never cached; a malformed code asks nothing. */
export async function fetchRules(request: RulesRequest): Promise<RulesResult> {
  if (!CODE.test(request.code)) {
    return { kind: "not_found" };
  }
  const headers = new Headers();
  if (request.forwardedFor !== null) {
    headers.set("x-forwarded-for", request.forwardedFor);
  }
  try {
    const response = await (request.fetchImpl ?? fetch)(
      `${request.apiOrigin}/v1/public/events/${encodeURIComponent(request.code)}/rules`,
      { headers, cache: "no-store", signal: AbortSignal.timeout(request.timeoutMs ?? 5000) },
    );
    if (response.status === 404) {
      return { kind: "not_found" };
    }
    if (response.status === 429) {
      return { kind: "throttled" };
    }
    const rules = response.ok ? readRules(await response.json().catch(() => undefined)) : undefined;
    return rules === undefined ? { kind: "unavailable" } : { kind: "found", rules };
  } catch {
    return { kind: "unavailable" };
  }
}

/** The organizer's own text in the page's language, else the other one; null when there is none. */
export const organizerTextIn = (rules: OfficialRules, language: Language): string | null =>
  rules.text[language] ?? rules.text[language === "ar" ? "en" : "ar"];
