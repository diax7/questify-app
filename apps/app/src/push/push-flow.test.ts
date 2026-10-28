import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import {
  EXPLAINER_KEY,
  EXPLAINER_SNOOZE_MS,
  REGISTRATION_INTERVAL_MS,
  REGISTRATION_KEY,
  apnsEnvironmentOf,
  appVersionOf,
  deviceBody,
  explainerDue,
  signInEnded,
  snoozeExplainer,
  syncRegistration,
  turnOn,
  unregisterDevice,
  type KeyValueStore,
  type PermissionState,
  type PushDeps,
  type PushNative,
  type SyncWho,
} from "#src/push/push-flow.ts";
import { channelNames } from "#src/push/channels.ts";

const IOS_TOKEN = "AB".repeat(32);
const FCM_TOKEN = "fcm-token_abcdefghij:KLMNO-1234";
const NAMES = channelNames((key) => key);
const WHO: SyncWho = { playerId: "player-a", language: "en", appVersion: "1.4.0" };
const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

const done = (): AuthedResult => ({ kind: "ok", status: 204, body: null, headers: new Headers() });
const down = (): AuthedResult => ({ kind: "network" });

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

type Phone = Readonly<{
  platform?: "ios" | "android";
  available?: boolean;
  permission?: PermissionState;
  token?: string;
  environment?: string | null;
}>;

/** A phone whose every answer is a spy, so a test can say what was and was not asked. */
function fixture(phone: Phone = {}) {
  const platform = phone.platform ?? "ios";
  const native = {
    available: vi.fn(() => phone.available ?? true),
    platform: () => platform,
    permission: vi.fn(async () => phone.permission ?? "granted"),
    ask: vi.fn(async () => "granted" as PermissionState),
    deviceToken: vi.fn(async () => phone.token ?? (platform === "ios" ? IOS_TOKEN : FCM_TOKEN)),
    apnsEnvironment: vi.fn(async () =>
      phone.environment === undefined ? "production" : phone.environment,
    ),
    ensureChannels: vi.fn(async () => undefined),
  } satisfies PushNative;
  const request = vi.fn<(...args: unknown[]) => Promise<AuthedResult>>(async () => done());
  const store = memoryStore();
  let now = T0;
  const deps: PushDeps = { native, session: { request }, store, now: () => now };
  return {
    native,
    request,
    store,
    deps,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function putBodyOf(request: ReturnType<typeof fixture>["request"]): unknown {
  const call = request.mock.calls[0];
  if (call === undefined) throw new Error("the server was not called");
  return (call[0] as { body: unknown }).body;
}

describe("what the server is told", () => {
  it("sends an iOS token in lower case with the environment the build reads", async () => {
    const f = fixture();
    expect(await syncRegistration(f.deps, WHO)).toBe("registered");
    expect(f.request).toHaveBeenCalledExactlyOnceWith({
      method: "PUT",
      path: "/v1/me/push-device",
      body: {
        platform: "ios",
        token: IOS_TOKEN.toLowerCase(),
        environment: "production",
        language: "en",
        appVersion: "1.4.0",
      },
    });
  });

  it.each([
    ["development", "sandbox"],
    ["production", "production"],
    [null, "production"],
    ["something else", "production"],
  ])("reads the APNs environment %j as %s", async (raw, sent) => {
    const f = fixture({ environment: raw });
    await syncRegistration(f.deps, WHO);
    expect((putBodyOf(f.request) as { environment: string }).environment).toBe(sent);
    expect(apnsEnvironmentOf(raw)).toBe(sent);
  });

  it("reads a failed environment lookup as production", async () => {
    const f = fixture();
    f.native.apnsEnvironment.mockRejectedValueOnce(new Error("no provisioning file"));
    await syncRegistration(f.deps, WHO);
    expect((putBodyOf(f.request) as { environment: string }).environment).toBe("production");
  });

  it("sends an Android token as it is and names no environment", async () => {
    const f = fixture({ platform: "android" });
    await syncRegistration(f.deps, { ...WHO, language: "ar", appVersion: "2.0.1" });
    expect(putBodyOf(f.request)).toEqual({
      platform: "android",
      token: FCM_TOKEN,
      language: "ar",
      appVersion: "2.0.1",
    });
    expect(f.native.apnsEnvironment).not.toHaveBeenCalled();
  });

  it("sends a version the server will take, whatever the build says", () => {
    expect(appVersionOf("0.1.0")).toBe("0.1.0");
    for (const version of [undefined, null, "", "1.0 beta", "x".repeat(21)]) {
      expect(appVersionOf(version)).toBe("unknown");
    }
  });

  it("uses a token the phone has just announced instead of asking for one", async () => {
    const f = fixture({ platform: "android" });
    await syncRegistration(f.deps, WHO, "fresh_token_abcdefghijklmnop");
    expect(f.native.deviceToken).not.toHaveBeenCalled();
    expect((putBodyOf(f.request) as { token: string }).token).toBe("fresh_token_abcdefghijklmnop");
  });

  it("builds the body the shared schema accepts", () => {
    expect(deviceBody("ios", "ABCD", null, "ar", "1.0.0")).toMatchObject({
      token: "abcd",
      environment: "production",
    });
  });
});

describe("when the phone does not register", () => {
  it.each(["denied", "undetermined"] as const)(
    "does nothing while the permission is %s, and asks the server nothing",
    async (permission) => {
      const f = fixture({ permission });
      expect(await syncRegistration(f.deps, WHO)).toBe("off");
      expect(f.native.deviceToken).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("does nothing on a phone that cannot do push", async () => {
    const f = fixture({ available: false });
    expect(await syncRegistration(f.deps, WHO)).toBe("off");
    expect(f.native.permission).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does nothing when the permission cannot be read", async () => {
    const f = fixture();
    f.native.permission.mockRejectedValueOnce(new Error("module gone"));
    expect(await syncRegistration(f.deps, WHO)).toBe("off");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("gives up quietly when the phone gives no token", async () => {
    const f = fixture();
    f.native.deviceToken.mockRejectedValueOnce(new Error("Default FirebaseApp is not initialized"));
    expect(await syncRegistration(f.deps, WHO)).toBe("failed");
    f.native.deviceToken.mockResolvedValueOnce("");
    expect(await syncRegistration(f.deps, WHO)).toBe("failed");
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("how often it registers", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(async () => {
    f = fixture();
    await syncRegistration(f.deps, WHO);
  });

  it("registers once, then leaves the server alone for the same device within a day", async () => {
    f.advance(REGISTRATION_INTERVAL_MS - 1);
    expect(await syncRegistration(f.deps, WHO)).toBe("unchanged");
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("registers again a day later", async () => {
    f.advance(REGISTRATION_INTERVAL_MS);
    expect(await syncRegistration(f.deps, WHO)).toBe("registered");
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a new token", () => f.native.deviceToken.mockResolvedValue("CD".repeat(32)), WHO],
    ["a new environment", () => f.native.apnsEnvironment.mockResolvedValue("development"), WHO],
    ["another language", () => undefined, { ...WHO, language: "ar" as const }],
    ["another app version", () => undefined, { ...WHO, appVersion: "1.5.0" }],
  ])("registers at once for %s", async (_name, change, who) => {
    change();
    expect(await syncRegistration(f.deps, who)).toBe("registered");
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("registers again when the clock went back before the last time", async () => {
    f.advance(-60_000);
    expect(await syncRegistration(f.deps, WHO)).toBe("registered");
  });

  it("registers again when the record is unreadable", async () => {
    const noPlayer = JSON.stringify({
      token: IOS_TOKEN.toLowerCase(),
      environment: "production",
      language: "en",
      appVersion: "1.4.0",
      at: f.now(),
    });
    for (const bad of ["not json", "null", '{"token":5}', '{"environment":"mars"}', noPlayer]) {
      f.store.data.set(REGISTRATION_KEY, bad);
      expect(await syncRegistration(f.deps, WHO), bad).toBe("registered");
    }
  });

  it("registers again for another player on the same phone, even within the day", async () => {
    expect(await syncRegistration(f.deps, { ...WHO, playerId: "player-b" })).toBe("registered");
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(await syncRegistration(f.deps, { ...WHO, playerId: "player-b" })).toBe("unchanged");
  });

  it("registers nothing until the player is known", async () => {
    const g = fixture();
    expect(await syncRegistration(g.deps, { ...WHO, playerId: undefined })).toBe("off");
    expect(g.native.deviceToken).not.toHaveBeenCalled();
    expect(g.request).not.toHaveBeenCalled();
  });
});

/** A server call that answers only when the test lets it. */
function slowCall() {
  const f = fixture();
  let answer!: (result: AuthedResult) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise<AuthedResult>((resolve) => {
        answer = resolve;
      }),
  );
  return { f, answer: (result: AuthedResult) => answer(result) };
}

describe("a registration on its way when the sign-in ends", () => {
  it("is not recorded, so the next sign-in registers instead of reading 'already told'", async () => {
    const { f, answer } = slowCall();
    const pending = syncRegistration(f.deps, WHO);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    signInEnded();
    answer(done());
    expect(await pending).toBe("off");
    expect(f.store.data.has(REGISTRATION_KEY)).toBe(false);
    expect(await syncRegistration(f.deps, WHO)).toBe("registered");
  });

  it("is not recorded either when the sign-out removes the device meanwhile", async () => {
    const { f, answer } = slowCall();
    const pending = syncRegistration(f.deps, WHO);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    await unregisterDevice(f.deps);
    answer(done());
    expect(await pending).toBe("off");
    expect(f.store.data.has(REGISTRATION_KEY)).toBe(false);
  });

  it("is recorded as usual when no sign-in ended meanwhile", async () => {
    const { f, answer } = slowCall();
    const pending = syncRegistration(f.deps, WHO);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    answer(done());
    expect(await pending).toBe("registered");
    expect(f.store.data.has(REGISTRATION_KEY)).toBe(true);
  });
});

describe("a call that fails", () => {
  it("is not recorded, so the next try registers", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(down());
    expect(await syncRegistration(f.deps, WHO)).toBe("failed");
    expect(f.store.data.has(REGISTRATION_KEY)).toBe(false);
    expect(await syncRegistration(f.deps, WHO)).toBe("registered");
  });

  it("is not recorded when the server refuses the device", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      kind: "error",
      status: 422,
      code: "invalid_push_device",
      message: null,
      details: {},
      headers: new Headers(),
    });
    expect(await syncRegistration(f.deps, WHO)).toBe("failed");
    expect(f.store.data.has(REGISTRATION_KEY)).toBe(false);
  });

  it("still registers when the store cannot be written", async () => {
    const f = fixture();
    const full: KeyValueStore = {
      ...f.store,
      setItem: async () => {
        throw new Error("disk full");
      },
    };
    expect(await syncRegistration({ ...f.deps, store: full }, WHO)).toBe("registered");
  });
});

describe("signing out", () => {
  it("removes the device on the server and forgets the record", async () => {
    const f = fixture();
    await syncRegistration(f.deps, WHO);
    f.request.mockClear();
    expect(await unregisterDevice(f.deps)).toBe(true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith({
      method: "DELETE",
      path: "/v1/me/push-device",
    });
    expect(f.store.data.has(REGISTRATION_KEY)).toBe(false);
  });

  it("calls nothing for a phone that never registered", async () => {
    const f = fixture();
    expect(await unregisterDevice(f.deps)).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("forgets the record even when the call fails", async () => {
    const f = fixture();
    await syncRegistration(f.deps, WHO);
    f.request.mockResolvedValueOnce(down());
    expect(await unregisterDevice(f.deps)).toBe(false);
    expect(f.store.data.has(REGISTRATION_KEY)).toBe(false);
  });
});

describe("the explainer", () => {
  it("is offered when the system has not been asked", async () => {
    expect(await explainerDue(fixture({ permission: "undetermined" }).deps)).toBe(true);
  });

  it.each(["granted", "denied"] as const)(
    "is never offered once the system said %s",
    async (permission) => {
      expect(await explainerDue(fixture({ permission }).deps)).toBe(false);
    },
  );

  it("is not offered on an Android build that cannot get a token (no Firebase file)", async () => {
    const f = fixture({ platform: "android", permission: "undetermined" });
    f.native.deviceToken.mockRejectedValueOnce(new Error("Default FirebaseApp is not initialized"));
    expect(await explainerDue(f.deps)).toBe(false);
    expect(
      await explainerDue(fixture({ platform: "android", permission: "undetermined" }).deps),
    ).toBe(true);
  });

  it("does not look for a token on iOS", async () => {
    const f = fixture({ platform: "ios", permission: "undetermined" });
    expect(await explainerDue(f.deps)).toBe(true);
    expect(f.native.deviceToken).not.toHaveBeenCalled();
  });

  it("is not offered on a phone that cannot do push, nor when the permission cannot be read", async () => {
    expect(await explainerDue(fixture({ permission: "undetermined", available: false }).deps)).toBe(
      false,
    );
    const f = fixture({ permission: "undetermined" });
    f.native.permission.mockRejectedValueOnce(new Error("module gone"));
    expect(await explainerDue(f.deps)).toBe(false);
  });

  it("waits 30 days after Not now, to the millisecond", async () => {
    const f = fixture({ permission: "undetermined" });
    await snoozeExplainer(f.deps);
    expect(f.store.data.get(EXPLAINER_KEY)).toBe(String(T0 + EXPLAINER_SNOOZE_MS));
    f.advance(EXPLAINER_SNOOZE_MS - 1);
    expect(await explainerDue(f.deps)).toBe(false);
    f.advance(1);
    expect(await explainerDue(f.deps)).toBe(true);
  });

  it("ignores a snooze it cannot read", async () => {
    const f = fixture({ permission: "undetermined" });
    f.store.data.set(EXPLAINER_KEY, "soon");
    expect(await explainerDue(f.deps)).toBe(true);
  });
});

describe("turning notifications on", () => {
  it("creates the channels, then shows the system prompt, then registers", async () => {
    const f = fixture({ platform: "android", permission: "undetermined" });
    const order: string[] = [];
    f.native.ensureChannels.mockImplementation(async () => void order.push("channels"));
    f.native.ask.mockImplementation(async () => {
      order.push("ask");
      f.native.permission.mockResolvedValue("granted");
      return "granted";
    });
    f.request.mockImplementation(async () => {
      order.push("register");
      return done();
    });
    expect(await turnOn(f.deps, WHO, NAMES)).toBe("granted");
    expect(order).toEqual(["channels", "ask", "register"]);
    expect(f.native.ensureChannels).toHaveBeenCalledWith(NAMES);
  });

  it("registers nothing when the answer is no", async () => {
    const f = fixture({ permission: "undetermined" });
    f.native.ask.mockResolvedValueOnce("denied");
    expect(await turnOn(f.deps, WHO, NAMES)).toBe("denied");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("still asks when the channels cannot be made, and answers denied when the prompt fails", async () => {
    const f = fixture({ permission: "undetermined" });
    f.native.ensureChannels.mockRejectedValueOnce(new Error("no channel manager"));
    f.native.ask.mockRejectedValueOnce(new Error("prompt failed"));
    expect(await turnOn(f.deps, WHO, NAMES)).toBe("denied");
    expect(f.native.ask).toHaveBeenCalledOnce();
  });

  it("does nothing on a phone that cannot do push", async () => {
    const f = fixture({ available: false });
    expect(await turnOn(f.deps, WHO, NAMES)).toBe("denied");
    expect(f.native.ask).not.toHaveBeenCalled();
  });
});
