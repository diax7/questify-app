import { eventRecapSchema, type EventRecap } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";

/**
 * What `GET /v1/events/{id}/recap` came to (T-410, FR-752). `gone` is the server's word that there is no recap for
 * this player (404: not a member who played, or an unknown event); `not_ended` says the event is still running.
 */
export type RecapAnswer =
  | Readonly<{ kind: "recap"; recap: EventRecap }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "not_ended" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

/** The recap's answer; anything unreadable is `network`, so a changed API shows "can't load" and nothing broken. */
export function recapAnswer(answer: AuthedResult): RecapAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    if (answer.status === 404) {
      return { kind: "gone" };
    }
    return answer.status === 409 && answer.code === "not_ended"
      ? { kind: "not_ended" }
      : { kind: "network" };
  }
  const parsed = eventRecapSchema.safeParse(answer.body);
  return parsed.success ? { kind: "recap", recap: parsed.data } : { kind: "network" };
}

export async function fetchRecap(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<RecapAnswer> {
  return recapAnswer(
    await session.request({
      method: "GET",
      path: `/v1/events/${encodeURIComponent(eventId)}/recap`,
    }),
  );
}
