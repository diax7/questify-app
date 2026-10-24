import type { DeviceKind } from "#src/lib/device.ts";
import type { Bilingual, CategoryView } from "#src/lib/quests.ts";

/** A device on the Devices page (`GET …/devices`, T-309): never a secret or a code. */
export type DeviceLine = Readonly<{
  id: string;
  kind: DeviceKind;
  label: string;
  quest: Bilingual | null;
  client: string;
  pairedBy: Readonly<{ type: "operator" | "staff"; name: string | null }> | null;
  pairedAt: string;
  lastSeenAt: string;
  activated: boolean;
  status: "active" | "revoked" | "ended";
  paused: boolean;
}>;

/** What the line shows as its state: revoked, ended, paused, waiting for activation, or active. */
export type DeviceStatus = "active" | "waiting" | "paused" | "ended" | "revoked";

const KINDS: ReadonlySet<unknown> = new Set(["station", "kiosk", "screen"]);
const STATUSES: ReadonlySet<unknown> = new Set(["active", "revoked", "ended"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual | null =>
  isRecord(value)
    ? {
        ar: typeof value["ar"] === "string" ? value["ar"] : null,
        en: typeof value["en"] === "string" ? value["en"] : null,
      }
    : null;

function lineOf(value: unknown): DeviceLine | undefined {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    !KINDS.has(value["kind"]) ||
    !STATUSES.has(value["status"]) ||
    typeof value["pairedAt"] !== "string" ||
    typeof value["lastSeenAt"] !== "string"
  ) {
    return undefined;
  }
  const by = isRecord(value["pairedBy"]) ? value["pairedBy"] : null;
  return {
    id: value["id"],
    kind: value["kind"] as DeviceKind,
    label: typeof value["label"] === "string" ? value["label"] : "",
    quest: textOf(value["quest"]),
    client: typeof value["client"] === "string" ? value["client"] : "",
    pairedBy:
      by === null
        ? null
        : {
            type: by["type"] === "operator" ? "operator" : "staff",
            name: typeof by["name"] === "string" ? by["name"] : null,
          },
    pairedAt: value["pairedAt"],
    lastSeenAt: value["lastSeenAt"],
    activated: value["activated"] === true,
    status: value["status"] as DeviceLine["status"],
    paused: value["paused"] === true,
  };
}

/** The devices in the list's answer, or undefined when it is not that shape. */
export function devicesOf(body: unknown): readonly DeviceLine[] | undefined {
  const list = isRecord(body) ? body["devices"] : undefined;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const lines = list.map(lineOf);
  return lines.every((line) => line !== undefined) ? lines : undefined;
}

/** A line's state as the page names it. */
export function statusOf(line: DeviceLine): DeviceStatus {
  if (line.status !== "active") {
    return line.status;
  }
  if (!line.activated) {
    return "waiting";
  }
  return line.paused ? "paused" : "active";
}

/** The quests a station may show: the event's scan quests with the screen QR on. */
export function stationQuests(
  categories: readonly CategoryView[],
): readonly Readonly<{ id: string; title: Bilingual }>[] {
  return categories.flatMap((category) =>
    category.quests
      .filter((quest) => quest.type === "scan_qr" && quest.verification.includes("screen_qr"))
      .map((quest) => ({ id: quest.id, title: quest.title })),
  );
}
