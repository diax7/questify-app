import type { PushMessage, PushProvider, PushResult, PushTarget } from "#src/push/provider";

/** One recorded send: the message, its target and the deadline it was given. */
export type FakeSend = Readonly<{ target: PushTarget; message: PushMessage; deadline: Date }>;

export type FakeProvider = PushProvider & {
  /** Every message handed to this provider, in order. */
  sent: FakeSend[];
  /** Results to answer, in order, before falling back to `sent`; a function sees the message. */
  script: ((message: PushMessage) => PushResult)[];
  /** How long each send takes (milliseconds of the clock `wait` uses). */
  latencyMs: number;
  closed: boolean;
};

export type FakeOptions = Readonly<{
  latencyMs?: number;
  /** Waits; replaced in tests with a fake clock's. */
  wait?: (ms: number) => Promise<void>;
}>;

const realWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * A provider for tests and the e2e API (ADR-344): records every message, answers scripted results and waits a set
 * latency. Never reaches a network.
 */
export function createFakeProvider(target: PushTarget, options: FakeOptions = {}): FakeProvider {
  const wait = options.wait ?? realWait;
  const fake: FakeProvider = {
    target,
    sent: [],
    script: [],
    latencyMs: options.latencyMs ?? 0,
    closed: false,
    send: async (message, deadline) => {
      fake.sent.push({ target, message, deadline });
      if (fake.latencyMs > 0) await wait(fake.latencyMs);
      const next = fake.script.shift();
      return next === undefined ? { kind: "sent" } : next(message);
    },
    close: () => {
      fake.closed = true;
      return Promise.resolve();
    },
  };
  return fake;
}
