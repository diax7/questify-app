import type { Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";
import { sourceOf, type RedemptionSource } from "#src/event/shop-api.ts";
import { deskInfoOf, type DeskInfo } from "#src/operator/desk.ts";

/** A prize the player holds and has not collected, as `GET /v1/events/{id}/held-prizes` gives it (T-602d). */
export type HeldPrize = Readonly<{
  id: string;
  name: Bilingual;
  /** The pickup time of a shop reservation; the claim deadline of a rank or quest prize. */
  reservedUntil: string | null;
  /** The player's live Collect (collect first), or null. */
  collectUntil: string | null;
  source: RedemptionSource;
}>;

export type HeldPrizes = Readonly<{ desk: DeskInfo; prizes: readonly HeldPrize[] }>;

export type HeldPrizesAnswer =
  | Readonly<{ kind: "held"; held: HeldPrizes }>
  | Readonly<{ kind: "unavailable" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringOr = (value: unknown): string | null => (typeof value === "string" ? value : null);

const textOf = (value: unknown): Bilingual =>
  isRecord(value)
    ? { ar: stringOr(value["ar"]), en: stringOr(value["en"]) }
    : { ar: null, en: null };

function prizeOf(value: unknown): HeldPrize | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  return {
    id: value["id"],
    name: textOf(value["name"]),
    reservedUntil: stringOr(value["reservedUntil"]),
    collectUntil: stringOr(value["collectUntil"]),
    source: sourceOf(value["source"], null),
  };
}

/** Reads the answer; undefined when it is not one (a proxy page, a broken body). Bad rows are left out. */
export function readHeldPrizes(body: unknown): HeldPrizes | undefined {
  if (!isRecord(body) || !Array.isArray(body["prizes"])) {
    return undefined;
  }
  const desk = deskInfoOf(body["desk"]);
  if (desk === undefined) {
    return undefined;
  }
  return {
    desk,
    prizes: body["prizes"].map(prizeOf).filter((prize): prize is HeldPrize => prize !== undefined),
  };
}

/**
 * The player's uncollected prizes. Not behind the shop's switch, so a prize reserved before the shop went off is still
 * here. Anything but a readable answer is `unavailable`: the card keeps what it showed, and Home's own read speaks for
 * the event.
 */
export async function fetchHeldPrizes(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<HeldPrizesAnswer> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${eventId}/held-prizes`,
  });
  if (answer.kind !== "ok") {
    return { kind: "unavailable" };
  }
  const held = readHeldPrizes(answer.body);
  return held === undefined ? { kind: "unavailable" } : { kind: "held", held };
}

/** Whether the player's Collect is still live: the prize is ready at the desk. */
export function isCollecting(prize: HeldPrize, now: number): boolean {
  return prize.collectUntil !== null && Date.parse(prize.collectUntil) > now;
}
