import { CHEER_MOMENT_DEFAULT_MINUTES, CHEER_MOMENT_MINUTES } from "@questify/shared";

/** The Cheers section of the Big screen page as `GET …/cheers` answers it (T-509). */
export type CheersReading = Readonly<{
  /** Whether the big-screen add-on is active; a moment cannot start without it. */
  enabled: boolean;
  /** The event's own Cheers switch. */
  switchOn: boolean;
  /** Whether the platform allows Cheers at all. */
  platformOn: boolean;
  /** The live moment's end (ISO), or null. */
  endsAt: string | null;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The reading in an answer, or undefined when it is not one. */
export function cheersReadingOf(body: unknown): CheersReading | undefined {
  if (!isRecord(body) || typeof body["enabled"] !== "boolean") {
    return undefined;
  }
  const live = isRecord(body["live"]) ? body["live"] : null;
  return {
    enabled: body["enabled"],
    switchOn: body["switch"] !== false,
    platformOn: body["platformOn"] !== false,
    endsAt: live !== null && typeof live["endsAt"] === "string" ? live["endsAt"] : null,
  };
}

/** Whether the owner can start a moment now: the add-on and both switches on, and none live yet. */
export const canStartCheers = (reading: CheersReading): boolean =>
  reading.enabled && reading.switchOn && reading.platformOn && reading.endsAt === null;

/** The lengths offered for a moment, and the one chosen first. */
export const MOMENT_CHOICES: readonly number[] = CHEER_MOMENT_MINUTES;
export const DEFAULT_MOMENT_MINUTES = CHEER_MOMENT_DEFAULT_MINUTES;
