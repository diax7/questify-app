import { readScan } from "#src/event/scan.ts";
import { inviteTokenOf } from "#src/operator/station.ts";

/** What the scanner does with a code that passed its gate. */
export type ScanDecision =
  /** A personal operator code (T-204): its confirm screen. */
  | Readonly<{ kind: "invite"; token: string }>
  /** Not a Questify code: said once, with a warning buzz. */
  | Readonly<{ kind: "other" }>
  /** A join link: the join card. */
  | Readonly<{ kind: "join"; code: string }>
  /** Send it: `id` is the quest's, a passport step's, a hidden category's, or "meet" for another player's code. */
  | Readonly<{ kind: "read"; id: string; token: string }>;

/** Reads a camera code into what the scanner does with it; `extraOrigin` is the one extra web origin of this build. */
export function scanDecision(data: string, extraOrigin: string | null): ScanDecision {
  const invite = inviteTokenOf(data);
  if (invite !== null) {
    return { kind: "invite", token: invite };
  }
  const scan = readScan(data, extraOrigin);
  switch (scan.kind) {
    case "other":
      return { kind: "other" };
    case "join":
      return { kind: "join", code: scan.code };
    case "meet":
      return { kind: "read", id: "meet", token: scan.code };
    case "step":
      return { kind: "read", id: scan.stepId, token: scan.token };
    case "reveal":
      return { kind: "read", id: scan.categoryId, token: scan.token };
    default:
      return { kind: "read", id: scan.questId, token: scan.token };
  }
}

/** The haptic that follows a server answer: none for a lost answer, and none for a completion (it has its own). */
export type AnswerBuzz = "success" | "error" | "none";

export function answerBuzz(kind: string): AnswerBuzz {
  if (kind === "stamped" || kind === "revealed") {
    return "success";
  }
  return kind === "completed" || kind === "network" ? "none" : "error";
}

/** The quest a completion names (a meet or a station code names its own), else the id the code held. */
export function answerQuestId(answer: object, id: string): string {
  return "questId" in answer && typeof answer.questId === "string" ? answer.questId : id;
}
