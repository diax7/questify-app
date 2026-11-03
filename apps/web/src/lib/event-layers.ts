import {
  FEATURE_REQUEST_WAIT_HOURS,
  eventLayersSchema,
  type EventLayerRow,
  type EventLayers,
  type FeatureRequestState,
} from "@questify/shared";

/** Answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readEventLayers(body: unknown): EventLayers | undefined {
  const parsed = eventLayersSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** Whether the owner is offered a switch for the feature: listed (the platform leaves it on) and not an add-on. */
export function isSwitchListed(layers: EventLayers | null, key: string): boolean {
  return layers?.features.some((row) => row.key === key && !row.addOn) === true;
}

/** The one add-on's row, or undefined when the platform keeps it off for this organizer (it is then not shown at all). */
export function addOnRow(layers: EventLayers | null, key: string): EventLayerRow | undefined {
  return layers?.features.find((row) => row.key === key && row.addOn);
}

/** The add-ons the owner sees (the platform leaves them on), each locked or unlocked, in key order. */
export function addOnRows(layers: EventLayers | null): readonly EventLayerRow[] {
  return layers?.features.filter((row) => row.addOn) ?? [];
}

/** What a locked add-on's card offers (FR-1827): Ask Questify, Requested, or Not approved with when to ask again. */
export type AskState =
  | Readonly<{ kind: "ask" | "requested" }>
  | Readonly<{ kind: "declined"; askAgainAt: string | null }>;

/**
 * The card's state from the owner's latest request: none (or one allowed, then locked again) offers Ask Questify; an
 * open one says Requested; a declined one says Not approved, with Ask again once 24 hours have passed (`askAgainAt` null).
 */
export function askState(request: FeatureRequestState | null, now: number): AskState {
  if (request === null || request.status === "allowed") {
    return { kind: "ask" };
  }
  if (request.status === "open") {
    return { kind: "requested" };
  }
  const again = Date.parse(request.at) + FEATURE_REQUEST_WAIT_HOURS * 3_600_000;
  return { kind: "declined", askAgainAt: again > now ? new Date(again).toISOString() : null };
}

/** The card's button: Ask Questify, Ask again once a decline's wait is over, or none. */
export function askButtonOf(state: AskState): "ask" | "askAgain" | null {
  if (state.kind === "ask") {
    return "ask";
  }
  return state.kind === "declined" && state.askAgainAt === null ? "askAgain" : null;
}
