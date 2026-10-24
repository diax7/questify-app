import { QUEST_CODE_HOSTS, type LocalizedText, type MessageKey } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";

type Requester = Pick<Session, "request">;

/** The kinds of paired browser (T-309); staff mode pairs stations, the dashboard every kind. */
export type DeviceKind = "station" | "kiosk" | "screen";

const KINDS: ReadonlySet<unknown> = new Set(["station", "kiosk", "screen"]);
/** 31 letters and digits without 0, O, 1, I and L (apps/api/src/devices/pairing-code.ts). */
const PAIRING = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual => {
  const text = isRecord(value) ? value : {};
  return {
    ar: typeof text["ar"] === "string" ? text["ar"] : null,
    en: typeof text["en"] === "string" ? text["en"] : null,
  };
};

/** A typed code in its sent form: case, dashes and spaces ignored; undefined when it is not 8 characters of the set. */
export function pairingCodeOf(typed: string): string | undefined {
  const code = typed.replaceAll(/[\s-]/g, "").toUpperCase();
  return PAIRING.test(code) ? code : undefined;
}

/**
 * The code in a pairing page's QR (`https://{host}/{lang}/pair#ABCDEFGH`), only on a Questify host or this build's
 * extra one, or null. The code rides in the fragment, so no server log ever held it.
 */
export function scannedPairingCode(text: string, extraOrigin: string | null): string | null {
  const link = /^https:\/\/([A-Za-z0-9.-]+)\/(?:ar|en)\/pair#([A-Za-z0-9]{8})$/.exec(text.trim());
  if (link === null) {
    return null;
  }
  const host = (link[1] ?? "").toLowerCase();
  const known = QUEST_CODE_HOSTS.includes(host) || `https://${host}` === extraOrigin;
  return known ? (pairingCodeOf(link[2] ?? "") ?? null) : null;
}

/** A refusal in the API's own words, or a lost connection. */
export type Failed =
  | Readonly<{ kind: "refused"; code: string; message: LocalizedText | null }>
  | Readonly<{ kind: "network" | "signed_out" }>;

const failedOf = (answer: AuthedResult): Failed =>
  answer.kind === "error"
    ? { kind: "refused", code: answer.code, message: answer.message }
    : { kind: answer.kind === "signed_out" ? "signed_out" : "network" };

const base = (eventId: string) => `/v1/operator/events/${encodeURIComponent(eventId)}`;

export type Preview = Readonly<{ kind: DeviceKind; client: string }>;

/** What the screen told the API, before the operator confirms (`POST …/devices/preview`). */
export async function previewDevice(
  session: Requester,
  eventId: string,
  code: string,
): Promise<Readonly<{ kind: "preview"; preview: Preview }> | Failed> {
  const answer = await session.request({
    method: "POST",
    path: `${base(eventId)}/devices/preview`,
    body: { code },
  });
  if (answer.kind !== "ok") {
    return failedOf(answer);
  }
  const body = isRecord(answer.body) ? answer.body : {};
  return KINDS.has(body["kind"])
    ? {
        kind: "preview",
        preview: {
          kind: body["kind"] as DeviceKind,
          client: typeof body["client"] === "string" ? body["client"] : "",
        },
      }
    : { kind: "network" };
}

export type Claim = Readonly<{ code: string; kind: DeviceKind; questId: string; label: string }>;

/** Pairs the screen (`POST …/devices`); the key is the caller's, so a retry after a lost answer pairs once. */
export async function claimDevice(
  session: Requester,
  eventId: string,
  claim: Claim,
  key: string,
): Promise<Readonly<{ kind: "paired"; id: string }> | Failed> {
  const answer = await session.request({
    method: "POST",
    path: `${base(eventId)}/devices`,
    body: claim,
    headers: { "idempotency-key": key },
  });
  if (answer.kind !== "ok") {
    return failedOf(answer);
  }
  const id = isRecord(answer.body) ? answer.body["id"] : undefined;
  return typeof id === "string" ? { kind: "paired", id } : { kind: "network" };
}

export type MyDevice = Readonly<{
  id: string;
  kind: DeviceKind;
  label: string;
  quest: Bilingual | null;
  status: "active" | "revoked" | "ended";
  paused: boolean;
}>;

export type StationQuest = Readonly<{ id: string; title: Bilingual; points: number }>;

/** The operator's devices page: what they paired, and the quests they may pair a station for or show themselves. */
export type DevicesPage = Readonly<{
  devices: readonly MyDevice[];
  quests: readonly StationQuest[];
}>;

const rows = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

export function devicesPageOf(body: unknown): DevicesPage {
  const page = isRecord(body) ? body : {};
  return {
    devices: rows(page["devices"])
      .filter((row) => typeof row["id"] === "string" && KINDS.has(row["kind"]))
      .map((row) => ({
        id: String(row["id"]),
        kind: row["kind"] as DeviceKind,
        label: typeof row["label"] === "string" ? row["label"] : "",
        quest: isRecord(row["quest"]) ? textOf(row["quest"]) : null,
        status:
          row["status"] === "revoked" ? "revoked" : row["status"] === "ended" ? "ended" : "active",
        paused: row["paused"] === true,
      })),
    quests: rows(page["quests"])
      .filter((row) => typeof row["id"] === "string")
      .map((row) => ({
        id: String(row["id"]),
        title: textOf(row["title"]),
        points: Number(row["points"] ?? 0),
      })),
  };
}

export async function fetchDevices(
  session: Requester,
  eventId: string,
): Promise<Readonly<{ kind: "page"; page: DevicesPage }> | Failed> {
  const answer = await session.request({ method: "GET", path: `${base(eventId)}/devices` });
  return answer.kind === "ok"
    ? { kind: "page", page: devicesPageOf(answer.body) }
    : failedOf(answer);
}

/** Revokes a device the operator paired: its screen goes blank at its next request. */
export async function revokeDevice(
  session: Requester,
  eventId: string,
  deviceId: string,
): Promise<Readonly<{ kind: "revoked" }> | Failed> {
  const answer = await session.request({
    method: "POST",
    path: `${base(eventId)}/devices/${encodeURIComponent(deviceId)}/revoke`,
    body: {},
  });
  return answer.kind === "ok" ? { kind: "revoked" } : failedOf(answer);
}

/** A rotating code to show, or why none is shown (`shut`). */
export type ScreenCode =
  | Readonly<{ kind: "code"; url: string; changesInMs: number }>
  | Readonly<{ kind: "shut"; shut: string }>;

/** The quest's code on the operator's own phone (`GET …/quests/{id}/screen-code`, FR-922). */
export async function fetchScreenCode(
  session: Requester,
  eventId: string,
  questId: string,
): Promise<ScreenCode | Failed> {
  const answer = await session.request({
    method: "GET",
    path: `${base(eventId)}/quests/${encodeURIComponent(questId)}/screen-code`,
  });
  if (answer.kind !== "ok") {
    return failedOf(answer);
  }
  const body = isRecord(answer.body) ? answer.body : {};
  if (body["state"] === "open") {
    return typeof body["url"] === "string" && typeof body["changesInMs"] === "number"
      ? { kind: "code", url: body["url"], changesInMs: body["changesInMs"] }
      : { kind: "network" };
  }
  return typeof body["state"] === "string"
    ? { kind: "shut", shut: body["state"] }
    : { kind: "network" };
}

const SHUT_KEYS: Readonly<Record<string, MessageKey>> = {
  paused: "device.shut.paused",
  method_off: "device.shut.methodOff",
  not_started: "device.shut.notStarted",
  ended: "device.shut.ended",
  event_ended: "device.shut.eventEnded",
};

/** The sentence shown instead of a code; an unknown reason reads as not available now. */
export const shutKey = (shut: string): MessageKey => SHUT_KEYS[shut] ?? "device.shut.hidden";

/** When to ask for the next code: when this one changes, plus up to 1.5 s of jitter, never by the phone's clock. */
export const nextCodeDelayMs = (changesInMs: number, random: number): number =>
  Math.max(changesInMs, 0) + Math.floor(Math.min(Math.max(random, 0), 1) * 1500);

/** How long a code may stay up without a fresh answer: until 15 seconds after it changed (the door's grace). */
export const codeGraceMs = (changesInMs: number): number => Math.max(changesInMs, 0) + 15_000;

/** The status a device line shows. */
export const deviceStatusKey = (device: MyDevice): MessageKey =>
  device.status === "revoked"
    ? "devices.status.revoked"
    : device.status === "ended"
      ? "devices.status.ended"
      : device.paused
        ? "devices.status.paused"
        : "devices.status.active";
