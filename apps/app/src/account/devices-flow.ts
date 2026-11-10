import type { LocalizedText, MessageKey } from "@questify/shared";
import type { Channel } from "#src/auth/sign-in-flow.ts";

type Problem = LocalizedText | null;

/** One signed-in device as `GET /v1/me/devices` answers it (T-810c, FR-140). */
export type Device = Readonly<{
  id: string;
  platform: "ios" | "android" | "web" | null;
  model: string | null;
  signedInAt: string;
  lastUsedAt: string;
  current: boolean;
}>;

/** What the player is signing out: one other device, or all of them. */
export type Target =
  | Readonly<{ kind: "one"; id: string; name: string }>
  | Readonly<{ kind: "others" }>;

type Listed = Readonly<{ devices: readonly Device[]; notice: MessageKey | null; problem: Problem }>;

/**
 * The signed-in devices screen: the list, a confirmation, then (only when this phone's sign-in is not fresh) a code to
 * the account's own phone or email, then the end and a fresh list. Nothing here talks to the network.
 */
export type DevicesState =
  | Readonly<{ step: "loading"; notice: MessageKey | null }>
  | Readonly<{ step: "failed"; problem: Problem }>
  | (Listed & Readonly<{ step: "list" }>)
  | (Listed & Readonly<{ step: "confirm"; target: Target }>)
  | (Listed &
      Readonly<{
        step: "reauth";
        target: Target;
        sent: Readonly<{ challengeToken: string; sentTo: string; resendAt: number }> | null;
        attemptsLeft: number | null;
      }>);

export type DevicesEvent =
  | Readonly<{ type: "loaded"; devices: readonly Device[] }>
  | Readonly<{ type: "load_failed"; problem: Problem }>
  | Readonly<{ type: "ask"; target: Target }>
  | Readonly<{ type: "cancel" }>
  | Readonly<{ type: "refused"; problem: Problem }>
  | Readonly<{ type: "reauth_required" }>
  | Readonly<{ type: "code_sent"; challengeToken: string; sentTo: string; now: number }>
  | Readonly<{ type: "wrong_code"; attemptsLeft: number; problem: Problem }>
  /** The code ended (410): ask for a new one. */
  | Readonly<{ type: "code_expired"; problem: Problem }>
  /** The code was right: the end is tried again by the screen. */
  | Readonly<{ type: "confirmed" }>
  | Readonly<{ type: "ended"; target: Target }>
  /** Another device already ended it, or it is no longer the player's (404): the list is read again. */
  | Readonly<{ type: "gone" }>;

/** The wait before another code (the sign-in screens use the same minute). */
export const RESEND_AFTER_MS = 60_000;

export const startDevices: DevicesState = { step: "loading", notice: null };

const listed = (state: DevicesState): Listed | null =>
  state.step === "list" || state.step === "confirm" || state.step === "reauth"
    ? { devices: state.devices, notice: state.notice, problem: state.problem }
    : null;

type Of<T extends DevicesEvent["type"]> = Extract<DevicesEvent, Readonly<{ type: T }>>;
type ListEvent = Exclude<
  DevicesEvent,
  Readonly<{ type: "loaded" | "load_failed" | "ended" | "gone" }>
>;
type Reauth = Extract<DevicesState, { step: "reauth" }>;

/** The answers any step takes: a list read, or an end that sends the screen back to reading it. */
function anyStep(state: DevicesState, event: DevicesEvent): DevicesState | undefined {
  if (event.type === "loaded") {
    const notice = state.step === "loading" ? state.notice : null;
    return { step: "list", devices: event.devices, notice, problem: null };
  }
  if (event.type === "load_failed") {
    return state.step === "loading" ? { step: "failed", problem: event.problem } : state;
  }
  if (event.type === "ended") {
    const notice = event.target.kind === "one" ? "myDevices.doneOne" : "myDevices.doneOthers";
    return { step: "loading", notice };
  }
  return event.type === "gone" ? { step: "loading", notice: "myDevices.alreadyEnded" } : undefined;
}

/** The answers of the code step; anything else leaves it as it is. */
const ON_REAUTH: Readonly<{
  [K in "code_sent" | "wrong_code" | "code_expired" | "confirmed"]: (
    state: Reauth,
    event: Of<K>,
    base: Listed,
  ) => DevicesState;
}> = {
  code_sent: (state, event) => ({
    ...state,
    sent: {
      challengeToken: event.challengeToken,
      sentTo: event.sentTo,
      resendAt: event.now + RESEND_AFTER_MS,
    },
    attemptsLeft: null,
    problem: null,
  }),
  wrong_code: (state, event) => ({
    ...state,
    attemptsLeft: event.attemptsLeft,
    problem: event.problem,
  }),
  code_expired: (state, event) => ({ ...state, sent: null, problem: event.problem }),
  confirmed: (state, _event, base) => ({ ...base, step: "confirm", target: state.target }),
};

function withList(state: DevicesState, base: Listed, event: ListEvent): DevicesState {
  switch (event.type) {
    case "ask":
      return { ...base, step: "confirm", target: event.target, notice: null, problem: null };
    case "cancel":
      return { ...base, step: "list", problem: null };
    case "refused":
      return { ...state, problem: event.problem } as DevicesState;
    case "reauth_required":
      return state.step === "confirm"
        ? {
            ...base,
            step: "reauth",
            target: state.target,
            sent: null,
            attemptsLeft: null,
            problem: null,
          }
        : state;
    default:
      return state.step === "reauth"
        ? (ON_REAUTH[event.type] as (s: Reauth, e: ListEvent, b: Listed) => DevicesState)(
            state,
            event,
            base,
          )
        : state;
  }
}

/** The next step for an answer. An answer that does not fit the step (a late reply) leaves it as it is. */
export function devicesStep(state: DevicesState, event: DevicesEvent): DevicesState {
  const settled = anyStep(state, event);
  if (settled !== undefined) {
    return settled;
  }
  const base = listed(state);
  return base === null ? state : withList(state, base, event as ListEvent);
}

/** The channels a code can go to: the account's own phone and email, as far as it has them. */
export function codeChannels(identifiers: Readonly<Record<Channel, string | null>>): Channel[] {
  return (["phone", "email"] as const).filter((channel) => identifiers[channel] !== null);
}

/** The name a device shows: its model, else its platform's name. */
export function fallbackNameKey(device: Pick<Device, "platform">): MessageKey {
  if (device.platform === "ios") return "myDevices.fallbackIos";
  if (device.platform === "android") return "myDevices.fallbackAndroid";
  if (device.platform === "web") return "myDevices.fallbackWeb";
  return "myDevices.fallbackPhone";
}

/** The calendar day of an instant in the phone's own zone, as `YYYY-MM-DD`. */
const pad = (n: number) => String(n).padStart(2, "0");
const calendarDay = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

export function localDay(instant: Date): string {
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

/** Whole calendar days between the device's last use and today, in the phone's own zone: a day, never a time. */
export function daysSince(lastUsed: Date, now: Date): number {
  return Math.max(0, Math.round((calendarDay(now) - calendarDay(lastUsed)) / 86_400_000));
}
