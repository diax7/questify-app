/**
 * Reading the phone's position for location quests (T-303b, ADR-206, ADR-208). Only while the app is open, never in
 * the background; asked for only from the explanation sheet's one "Continue" button. A check-in takes a fresh fix
 * (8 s at most); a QR scan or a typed code takes only the last known fix no older than 2 minutes, never a fresh one,
 * and never asks: a scan is never delayed or blocked by location. The native module is loaded on demand, so a build
 * without it (or an unexpected failure) reads as "unavailable" and the player scans the QR instead.
 */

/** A reading as the API takes it: every value client-reported (ADR-206). */
export type Position = Readonly<{
  lat: number;
  lng: number;
  accuracyM: number;
  ageS: number;
  mocked?: boolean;
}>;

/** What the location module gives: coordinates, accuracy in metres (null when unknown), the fix's time in ms. */
export type Fix = Readonly<{
  coords: Readonly<{ latitude: number; longitude: number; accuracy: number | null }>;
  timestamp: number;
  mocked?: boolean | undefined;
}>;

export type Permission = "granted" | "denied" | "undetermined";

/** The device's location, behind an interface so the logic runs in tests. */
export type LocationReader = Readonly<{
  /** The permission now, without asking. */
  permission: () => Promise<Permission>;
  /** Opens the system prompt (only from the explanation sheet's Continue). */
  ask: () => Promise<Permission>;
  /** A fresh, high-accuracy fix. */
  current: () => Promise<Fix>;
  /** The last known fix no older than `maxAgeMs`, or null. */
  lastKnown: (maxAgeMs: number) => Promise<Fix | null>;
}>;

/** How long a check-in waits for a fix before offering the QR. */
export const CHECK_IN_TIMEOUT_MS = 8000;
/** The longest a scan waits for the phone's last known fix before going without it. */
export const LAST_KNOWN_WAIT_MS = 500;
/** The oldest fix a scan may carry, and the oldest the server takes (migration 0048). */
export const RECENT_FIX_MS = 120_000;

/** A fix as the API reads it, or null when it has no accuracy (the server would refuse it). */
export function readingOf(fix: Fix, now: number): Position | null {
  const accuracy = fix.coords.accuracy;
  if (accuracy === null || !(accuracy > 0)) {
    return null;
  }
  return {
    lat: fix.coords.latitude,
    lng: fix.coords.longitude,
    accuracyM: accuracy,
    ageS: Math.max(0, Math.round((now - fix.timestamp) / 1000)),
    ...(fix.mocked === true ? { mocked: true } : {}),
  };
}

/**
 * The permission as the app acts on it: granted, or `undetermined` while the system may still show its prompt (never
 * asked, or denied where Android can ask again: `canAskAgain`), else denied (the settings link).
 */
export function permissionOf(
  answer: Readonly<{ status: unknown; canAskAgain?: unknown }>,
): Permission {
  if (answer.status === "granted") {
    return "granted";
  }
  return answer.status === "undetermined" || answer.canAskAgain === true
    ? "undetermined"
    : "denied";
}

/**
 * The phone's location module, loaded on demand: null when this build has none (a build made before T-303b's native
 * module, or a failure loading it), so nothing crashes and the QR stays the way in.
 */
export async function nativeReader(): Promise<LocationReader | null> {
  try {
    const Location = await import("expo-location");
    return {
      permission: async () => permissionOf(await Location.getForegroundPermissionsAsync()),
      ask: async () => permissionOf(await Location.requestForegroundPermissionsAsync()),
      current: () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      lastKnown: (maxAgeMs) => Location.getLastKnownPositionAsync({ maxAge: maxAgeMs }),
    };
  } catch {
    return null;
  }
}

/** Rejects with "timeout" after `ms`, or settles with the work, whichever comes first. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("location failed"));
      },
    );
  });
}

export type CheckInRead =
  | Readonly<{ kind: "position"; position: Position }>
  /** Asking first: the explanation sheet, then the system prompt. */
  | Readonly<{ kind: "ask" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "unavailable" }>;

/** A check-in's reading: a fresh fix once allowed, else what the sheet must do instead. Never asks by itself. */
export async function checkInRead(
  reader: LocationReader | null,
  now: () => number,
  timeoutMs = CHECK_IN_TIMEOUT_MS,
): Promise<CheckInRead> {
  if (reader === null) {
    return { kind: "unavailable" };
  }
  try {
    const permission = await reader.permission();
    if (permission !== "granted") {
      return { kind: permission === "undetermined" ? "ask" : "denied" };
    }
    const position = readingOf(await within(reader.current(), timeoutMs), now());
    return position === null ? { kind: "unavailable" } : { kind: "position", position };
  } catch (error) {
    return {
      kind: error instanceof Error && error.message === "timeout" ? "timeout" : "unavailable",
    };
  }
}

/**
 * The reading a QR scan or a typed code carries: the last known fix no older than 2 minutes, only while the platform's
 * switch is on and the player already allowed location. Null otherwise, and on any failure: a scan never waits.
 */
export async function scanReading(
  reader: LocationReader | null,
  locationOn: boolean,
  now: () => number,
): Promise<Position | null> {
  if (!locationOn || reader === null) {
    return null;
  }
  try {
    if ((await reader.permission()) !== "granted") {
      return null;
    }
    const fix = await within(reader.lastKnown(RECENT_FIX_MS), LAST_KNOWN_WAIT_MS);
    return fix === null ? null : readingOf(fix, now());
  } catch {
    return null;
  }
}

/** Stored once the explanation was shown after joining, so that path shows it once per install. */
export const EXPLAINED_KEY = "questify.locationExplained";

/**
 * Whether to show the explanation right after joining (ADR-208): the switch on, an in-person event with a venue pin
 * (the server's `locationPrompt`), not shown on this install before, and the player not asked yet. Never at launch:
 * the caller is the event's Home, opened after a join.
 */
export function explainAfterJoin(
  state: Readonly<{
    locationOn: boolean;
    locationPrompt: boolean;
    explained: boolean;
    permission: Permission | null;
  }>,
): boolean {
  return (
    state.locationOn &&
    state.locationPrompt &&
    !state.explained &&
    state.permission === "undetermined"
  );
}
