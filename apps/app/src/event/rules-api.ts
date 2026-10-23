import type { OfficialRules } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";

/** What the info page shows for the event's official rules (FR-1707, ADR-165). */
export type RulesAnswer =
  | Readonly<{ kind: "rules"; rules: OfficialRules }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "network" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isLines = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((line) => typeof line === "string");
const isText = (value: unknown): boolean => value === null || typeof value === "string";

/** Reads `{rules}`; undefined when it is not one. */
export function readRules(body: unknown): OfficialRules | undefined {
  const rules = isRecord(body) ? body["rules"] : undefined;
  if (!isRecord(rules) || !isRecord(rules["text"])) {
    return undefined;
  }
  const { block, text } = rules as { block: unknown; text: Record<string, unknown> };
  const blockOk =
    block === null || (isRecord(block) && isLines(block["ar"]) && isLines(block["en"]));
  return blockOk && isText(text["ar"]) && isText(text["en"]) ? (rules as OfficialRules) : undefined;
}

/** The answer of `GET /v1/events/{id}/rules`: a 404 means the event has no rules (no prizes, no text). */
export function rulesAnswer(answer: AuthedResult): RulesAnswer {
  if (answer.kind === "ok") {
    const rules = readRules(answer.body);
    return rules === undefined ? { kind: "network" } : { kind: "rules", rules };
  }
  return answer.kind === "error" && answer.status === 404 ? { kind: "none" } : { kind: "network" };
}

export async function fetchRules(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<RulesAnswer> {
  return rulesAnswer(
    await session.request({
      method: "GET",
      path: `/v1/events/${encodeURIComponent(eventId)}/rules`,
    }),
  );
}
