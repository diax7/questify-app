import { readEventTerms, type EventTerms, type MessageKey } from "@questify/shared";
import { scenesOf, type Scene } from "#src/lib/big-screen.ts";

/** The three kinds of paired browser (T-309, ADR-239); each has its own page with no ids in its address. */
export type DeviceKind = "station" | "kiosk" | "screen";

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A paired, activated device's view (`GET /v1/device`): nothing of an event comes before activation. */
export type PairedView = Readonly<{
  kind: DeviceKind;
  label: string;
  /** Why it shows nothing now (paused, method_off, hidden, not_started, ended, event_ended), or null. */
  shut: string | null;
  event: Readonly<{ name: Bilingual }>;
  quest: Readonly<{ title: Bilingual; points: number }> | null;
  /** A big screen's scenes to run, in order (T-504); null for a station, a kiosk or a shut screen. */
  scenes: readonly Scene[] | null;
  /** The event's own words, complete (Questify's own where it set none): a big screen shows its currency. */
  terms: EventTerms;
}>;

/** What `GET /v1/device` and the pairing calls answer, read defensively. */
export type DeviceAnswer =
  | Readonly<{ state: "pending"; kind: DeviceKind; code: string | null; expiresAt: string }>
  | Readonly<{ state: "waiting" }>
  | Readonly<{ state: "paired"; view: PairedView }>;

/** A station's code (`GET /v1/device/screen-code`): one to show, or why none is shown. */
export type ScreenCodeView =
  | Readonly<{ state: "open"; url: string; changesInMs: number; quest: PairedView["quest"] }>
  | Readonly<{ state: "shut"; shut: string; quest: PairedView["quest"] }>;

const KINDS: ReadonlySet<string> = new Set(["station", "kiosk", "screen"]);

const KIND_KEYS = {
  station: "device.kind.station",
  kiosk: "device.kind.kiosk",
  screen: "device.kind.screen",
} as const satisfies Record<DeviceKind, MessageKey>;

/** The name of a kind of device, as staff and the screens show it. */
export const deviceKindKey = (kind: DeviceKind): MessageKey => KIND_KEYS[kind];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual => {
  const text = isRecord(value) ? value : {};
  return {
    ar: typeof text["ar"] === "string" ? text["ar"] : null,
    en: typeof text["en"] === "string" ? text["en"] : null,
  };
};

const questOf = (value: unknown): PairedView["quest"] =>
  isRecord(value) && typeof value["points"] === "number"
    ? { title: textOf(value["title"]), points: value["points"] }
    : null;

/** A paired, activated device's view from the body of its answer. */
function viewOf(body: Record<string, unknown>, kind: DeviceKind): PairedView {
  const event = isRecord(body["event"]) ? body["event"] : {};
  return {
    kind,
    label: typeof body["label"] === "string" ? body["label"] : "",
    shut: typeof body["shut"] === "string" ? body["shut"] : null,
    event: { name: textOf(event["name"]) },
    quest: questOf(body["quest"]),
    scenes: Array.isArray(body["scenes"]) ? scenesOf(body["scenes"]) : null,
    terms: readEventTerms(body["terms"]),
  };
}

/** The device's state in an answer, or undefined when it is not one of the shapes above. */
export function deviceAnswerOf(body: unknown): DeviceAnswer | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const kind = body["kind"];
  if (body["state"] === "pending" && typeof kind === "string" && KINDS.has(kind)) {
    return {
      state: "pending",
      kind: kind as DeviceKind,
      code: typeof body["code"] === "string" ? body["code"] : null,
      expiresAt: String(body["expiresAt"] ?? ""),
    };
  }
  if (body["state"] !== "paired") {
    return undefined;
  }
  if (body["activated"] !== true || typeof kind !== "string" || !KINDS.has(kind)) {
    return { state: "waiting" };
  }
  return { state: "paired", view: viewOf(body, kind as DeviceKind) };
}

/** A screen-code answer, or undefined when it is not that shape. */
export function screenCodeOf(body: unknown): ScreenCodeView | undefined {
  if (!isRecord(body) || typeof body["state"] !== "string") {
    return undefined;
  }
  const quest = questOf(body["quest"]);
  if (body["state"] === "open") {
    return typeof body["url"] === "string" && typeof body["changesInMs"] === "number"
      ? { state: "open", url: body["url"], changesInMs: body["changesInMs"], quest }
      : undefined;
  }
  return { state: "shut", shut: body["state"], quest };
}

const SHUT_KEYS: Readonly<Record<string, MessageKey>> = {
  paused: "device.shut.paused",
  method_off: "device.shut.methodOff",
  not_started: "device.shut.notStarted",
  ended: "device.shut.ended",
  hidden: "device.shut.hidden",
  event_ended: "device.shut.eventEnded",
};

/** The sentence a shut station shows instead of a code; an unknown reason reads as not available now. */
export const shutKey = (shut: string): MessageKey => SHUT_KEYS[shut] ?? "device.shut.hidden";

/** The address a pairing page's QR holds: the code rides in the fragment, which never reaches a server log. */
export function pairUrl(origin: string, language: string, code: string): string {
  return `${origin}/${language}/pair#${code.replaceAll("-", "")}`;
}

/** The page a device of `kind` belongs on, in `language`. */
export const devicePagePath = (kind: DeviceKind, language: string): string =>
  `/${language}/${kind === "screen" ? "screen" : kind}`;

/** How long a polling page waits: 3 seconds, 5 after it was asked to slow down (ADR-239). */
export const pollDelayMs = (slowed: boolean): number => (slowed ? 5000 : 3000);

/**
 * When a station asks for its next code: when this one changes, plus up to 1.5 seconds of jitter so a hall of screens
 * does not ask at once. Always relative to the answer, never the screen's own clock.
 */
export const nextCodeDelayMs = (changesInMs: number, random: number): number =>
  Math.max(changesInMs, 0) + Math.floor(Math.min(Math.max(random, 0), 1) * 1500);

/** How long a fetched code may stay up without a fresh answer: until 15 seconds after it changed (the door's grace). */
export const codeGraceMs = (changesInMs: number): number => Math.max(changesInMs, 0) + 15_000;
