import type { LocalizedText, MessageKey } from "@questify/shared";
import type { Bilingual } from "#src/i18n/text.ts";
import type { TagWrite } from "#src/nfc/native.ts";
import type { Confirmed } from "#src/nfc/nfc-api.ts";

/**
 * A tag written on the phone whose confirm did not reach the server: retried with the same key and the same body (the
 * quest, label and lock as written, whatever the form says now), never rewritten.
 */
export type Pending = Readonly<{
  questId: string;
  quest: Bilingual;
  url: string;
  ticket: string;
  uid: string;
  label: string;
  locked: boolean;
  /** The operator asked for a lock the tag did not take. */
  lockMissed: boolean;
  key: string;
}>;

export type Step =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "writing" }>
  | Readonly<{ kind: "done"; quest: Bilingual; confirmed: Confirmed; lockMissed: boolean }>
  | Readonly<{ kind: "problem"; key: MessageKey; rewrite: boolean }>
  | Readonly<{ kind: "refused"; message: LocalizedText }>
  | Readonly<{ kind: "unconfirmed"; pending: Pending }>;

const PROBLEMS = {
  locked: "operator.nfc.locked",
  taken: "operator.nfc.taken",
  failed: "operator.nfc.failed",
  unsupported: "operator.nfc.unsupported",
  off: "operator.nfc.off",
  unusable: "operator.nfc.unusable",
} as const satisfies Record<string, MessageKey>;

/** Any answer that did not succeed; a refusal may carry the API's own words. */
type Failure = Readonly<{ kind: string; message?: LocalizedText | null }>;

/** The API's own words when it refused with some, otherwise nothing. */
function refusalMessage(answer: Failure): LocalizedText | null {
  return answer.kind === "refused" ? (answer.message ?? null) : null;
}

/** The step after the server refused (with its own words) or could not be reached before anything was written. */
export function prepareFailedStep(answer: Failure): Step {
  const message = refusalMessage(answer);
  return message === null
    ? { kind: "problem", key: "join.network", rewrite: false }
    : { kind: "refused", message };
}

/** The step after the phone could not write the tag; a taken tag offers Rewrite. */
export function writeFailedStep(kind: Exclude<TagWrite["kind"], "written" | "cancelled">): Step {
  return { kind: "problem", key: PROBLEMS[kind], rewrite: kind === "taken" };
}

/** The step after a confirm that did not register the tag: refused in the API's words, or unconfirmed (retry). */
export function confirmFailedStep(answer: Failure, pending: Pending): Step {
  const message = refusalMessage(answer);
  return message === null ? { kind: "unconfirmed", pending } : { kind: "refused", message };
}

/** The step after the tag was registered. */
export function confirmedStep(pending: Pending, confirmed: Confirmed): Step {
  return { kind: "done", quest: pending.quest, confirmed, lockMissed: pending.lockMissed };
}
