import type { JoinField } from "#src/join/join-api.ts";

/** What the player typed, by field id. */
export type Typed = Readonly<Record<string, string>>;

/** The most an answer holds (migration 0028). */
export const ANSWER_MAX = 200;

/** The first required field left empty, in the card's order, so the screen can point at it (FR-130). */
export function firstMissing(fields: readonly JoinField[], typed: Typed): string | undefined {
  return fields.find((field) => field.required && (typed[field.id] ?? "").trim() === "")?.id;
}

/** The answers to send: this card's fields only, trimmed, the empty ones left out. */
export function answersFor(fields: readonly JoinField[], typed: Typed): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const field of fields) {
    const value = (typed[field.id] ?? "").trim();
    if (value !== "") {
      answers[field.id] = value;
    }
  }
  return answers;
}

/**
 * Answers waiting through sign-in, by join code (ADR-089): in memory only, never in a route or on the device. Read
 * without removing (React may build a screen's state twice); forgotten after the join that follows sign-in, or when
 * sign-in is closed. Leaving sign-in by the back gesture keeps them in memory until the next sign-in or app restart.
 */
const waiting = new Map<string, Record<string, string>>();

export function holdAnswers(code: string, answers: Record<string, string>): void {
  waiting.set(code.toUpperCase(), answers);
}

export function heldAnswers(code: string): Record<string, string> | undefined {
  return waiting.get(code.toUpperCase());
}

export function forgetAnswers(code: string): void {
  waiting.delete(code.toUpperCase());
}
