import type { Language } from "@questify/shared";
import { readActivation, type ActivationView } from "#src/lib/activation.ts";

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a path segment can name an event; anything else must never reach an API path in the admin's browser. */
export function isEventId(value: string): boolean {
  return EVENT_ID.test(value);
}

type Text = Readonly<{ ar: string | null; en: string | null }>;

export type QueueItem = Readonly<{
  eventId: string;
  name: Text;
  organizer: string;
  requestedAt: string;
  startsAt: string | null;
  timezone: string;
}>;

export type ConsoleEvent = ActivationView &
  Readonly<{
    event: Readonly<{
      id: string;
      joinCode: string;
      name: Text;
      status: string;
      statusNow: string;
      timezone: string;
      startsAt: string | null;
      endsAt: string | null;
      organizer: Readonly<{ id: string; name: string }>;
      ownerEmail: string | null;
    }>;
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isText = (value: unknown): value is Text =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === "string";

/** The queue's rows; undefined when the answer is not the expected shape. */
export function readQueue(value: unknown): QueueItem[] | undefined {
  const rows = isRecord(value) ? value["requests"] : undefined;
  if (!Array.isArray(rows)) {
    return undefined;
  }
  const valid = rows.every(
    (row) =>
      isRecord(row) &&
      typeof row["eventId"] === "string" &&
      isText(row["name"]) &&
      typeof row["organizer"] === "string" &&
      typeof row["requestedAt"] === "string" &&
      isTextOrNull(row["startsAt"]) &&
      typeof row["timezone"] === "string",
  );
  return valid ? (rows as QueueItem[]) : undefined;
}

/** The console's event; undefined when the answer is not the expected shape. */
export function readConsoleEvent(value: unknown): ConsoleEvent | undefined {
  const event = isRecord(value) ? value["event"] : undefined;
  if (readActivation(value) === undefined || !isRecord(event)) {
    return undefined;
  }
  const organizer = event["organizer"];
  const valid =
    typeof event["id"] === "string" &&
    typeof event["joinCode"] === "string" &&
    isText(event["name"]) &&
    typeof event["status"] === "string" &&
    typeof event["statusNow"] === "string" &&
    typeof event["timezone"] === "string" &&
    isTextOrNull(event["startsAt"]) &&
    isTextOrNull(event["endsAt"]) &&
    isRecord(organizer) &&
    typeof organizer["name"] === "string" &&
    isTextOrNull(event["ownerEmail"]);
  return valid ? (value as ConsoleEvent) : undefined;
}

/** A name in the reader's language, else the other one. */
export function nameIn(name: Text, language: Language): string {
  return (language === "ar" ? (name.ar ?? name.en) : (name.en ?? name.ar)) ?? "";
}

/** What an event still needs before activation, from an `activation_incomplete` answer (ADR-142). */
export function missingField(body: unknown): "times" | "venue" | undefined {
  if (!isRecord(body) || body["code"] !== "activation_incomplete") {
    return undefined;
  }
  const field = isRecord(body["details"]) ? body["details"]["field"] : undefined;
  return field === "times" || field === "venue" ? field : undefined;
}

export type LimitDraft = Readonly<{ mode: "none" | "soft" | "hard"; value: string }>;

/** The limit the console sends: no number with none; the typed number otherwise (the API checks its range). */
export function limitBodyOf(draft: LimitDraft): Readonly<{ mode: string; value?: number }> {
  const text = draft.value.trim();
  if (draft.mode === "none" || text === "") {
    return { mode: draft.mode };
  }
  return { mode: draft.mode, value: Number(text) };
}
