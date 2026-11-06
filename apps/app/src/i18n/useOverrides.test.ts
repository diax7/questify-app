import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_OVERRIDES, type Overrides } from "@questify/shared";
import type { ApiRequest, ApiResult } from "#src/api/client.ts";
import { TRANSLATIONS_KEY, TRANSLATIONS_REFRESH_MS } from "#src/config/translations.ts";
import { useOverrides } from "#src/i18n/useOverrides.ts";

type Answer = ApiResult | Promise<ApiResult> | Error;

/**
 * The hook's three boundaries, faked: React's state and effect (one of each, run by hand), the app's foreground state,
 * and the network and storage behind `app-session`. Everything between them is the real hook and the real loader.
 */
const world = vi.hoisted(() => ({
  state: undefined as unknown,
  effect: undefined as undefined | (() => void | (() => void)),
  appState: "active",
  onChange: undefined as undefined | ((state: string) => void),
  unsubscribed: 0,
  requests: [] as ApiRequest[],
  answers: [] as Answer[],
  data: new Map<string, string>(),
  storageBroken: false,
}));

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    world.state ??= initial;
    return [
      world.state,
      (next: unknown) => {
        world.state = typeof next === "function" ? next(world.state) : next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void)) => {
    world.effect = effect;
  },
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return world.appState;
    },
    addEventListener: (_type: string, handler: (state: string) => void) => {
      world.onChange = handler;
      return {
        remove: () => {
          world.unsubscribed += 1;
        },
      };
    },
  },
}));

vi.mock("#src/api/app-session.ts", () => ({
  api: {
    client: {
      request: async (request: ApiRequest) => {
        world.requests.push(request);
        const next = world.answers.shift();
        if (next instanceof Error) {
          throw next;
        }
        return (await next) ?? { kind: "network" };
      },
    },
  },
  keyValueStore: {
    getItem: async (key: string) => {
      if (world.storageBroken) {
        throw new Error("storage is gone");
      }
      return world.data.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      world.data.set(key, value);
    },
  },
}));

const FIRST: Overrides = { ar: { "nav.home": "البداية" }, en: { "nav.home": "Start" } };
const SECOND: Overrides = { ar: {}, en: { "nav.home": "Begin" } };

const ok = (body: unknown): ApiResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});

/** An answer the test settles by hand, for one that arrives after the screen is gone. */
function deferred(): { promise: Promise<ApiResult>; resolve: (answer: ApiResult) => void } {
  const settle: { resolve: (answer: ApiResult) => void } = { resolve: () => undefined };
  const promise = new Promise<ApiResult>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, resolve: (answer) => settle.resolve(answer) };
}

/** Runs the hook once and its effect, like the first render of a screen; the returned function unmounts it. */
function mount(): { current: () => unknown; unmount: () => void } {
  useOverrides();
  const cleanup = world.effect?.();
  return {
    current: () => world.state,
    unmount: () => {
      if (typeof cleanup === "function") {
        cleanup();
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // A jitter of 2,500 ms: the first read waits that long, then reads every 30 s plus the jitter.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  world.state = undefined;
  world.effect = undefined;
  world.appState = "active";
  world.onChange = undefined;
  world.unsubscribed = 0;
  world.requests = [];
  world.answers = [];
  world.data = new Map();
  world.storageBroken = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useOverrides", () => {
  it("shows the shipped texts at first, then the last working copy kept on the phone", async () => {
    world.data.set(TRANSLATIONS_KEY, JSON.stringify({ etag: '"v1"', body: FIRST }));
    const screen = mount();
    expect(screen.current()).toEqual(NO_OVERRIDES);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.current()).toEqual(FIRST);
    expect(world.requests).toHaveLength(0);
    screen.unmount();
  });

  it("reads the server after the first wait, then again every 30 seconds", async () => {
    world.answers.push(ok(FIRST), ok(SECOND));
    const screen = mount();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(world.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(world.requests).toEqual([{ method: "GET", path: "/v1/translations" }]);
    expect(screen.current()).toEqual(FIRST);
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS + 2_500);
    expect(world.requests).toHaveLength(2);
    expect(screen.current()).toEqual(SECOND);
    screen.unmount();
  });

  it("keeps the very same texts when a read brings nothing new, so nothing redraws", async () => {
    world.answers.push(ok(FIRST), ok({ ...FIRST }));
    const screen = mount();
    await vi.advanceTimersByTimeAsync(2_500);
    const shown = screen.current();
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS + 2_500);
    expect(world.requests).toHaveLength(2);
    expect(screen.current()).toBe(shown);
    screen.unmount();
  });

  it("starts no reads while the app is in the background, and starts them when it comes back", async () => {
    world.appState = "background";
    world.answers.push(ok(FIRST));
    const screen = mount();
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS * 2);
    expect(world.requests).toHaveLength(0);
    world.onChange?.("active");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(world.requests).toHaveLength(1);
    expect(screen.current()).toEqual(FIRST);
    screen.unmount();
  });

  it("stops reading when the app goes to the background, and reads every 30 seconds again on return", async () => {
    const screen = mount();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(world.requests).toHaveLength(1);
    world.onChange?.("background");
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS * 3);
    expect(world.requests).toHaveLength(1);
    world.onChange?.("active");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(world.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS + 2_500);
    expect(world.requests).toHaveLength(3);
    screen.unmount();
  });

  it("keeps the shipped texts when the network throws, and reads again at the next turn", async () => {
    world.answers.push(new Error("offline"), ok(FIRST));
    const screen = mount();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(world.requests).toHaveLength(1);
    expect(screen.current()).toEqual(NO_OVERRIDES);
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS + 2_500);
    expect(screen.current()).toEqual(FIRST);
    screen.unmount();
  });

  it("keeps the shipped texts when the phone's storage cannot be read", async () => {
    world.storageBroken = true;
    const screen = mount();
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS + 2_500);
    expect(screen.current()).toEqual(NO_OVERRIDES);
    screen.unmount();
  });

  it("stops its timers and the app listener on unmount, and ignores an answer that arrives later", async () => {
    const late = deferred();
    world.answers.push(late.promise);
    const screen = mount();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(world.requests).toHaveLength(1);
    screen.unmount();
    expect(world.unsubscribed).toBe(1);
    late.resolve(ok(FIRST));
    await vi.advanceTimersByTimeAsync(TRANSLATIONS_REFRESH_MS * 3);
    expect(screen.current()).toEqual(NO_OVERRIDES);
    expect(world.requests).toHaveLength(1);
  });
});
