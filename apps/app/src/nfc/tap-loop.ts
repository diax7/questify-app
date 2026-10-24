import type { TagRead } from "#src/nfc/native.ts";

/** A wait for the app to come back to the front, which `cancel` ends early. */
export type ActiveWait = Readonly<{ done: Promise<void>; cancel: () => void }>;

export type TapLoopDeps = Readonly<{
  read: () => Promise<TagRead>;
  onRead: (read: Extract<TagRead, { kind: "read" }>) => void;
  /** NFC is switched off (true) or on again (false). */
  onOff: (off: boolean) => void;
  /** Resolves when the app is active again (the person comes back from Settings). */
  untilActive: () => ActiveWait;
  pause: (ms: number) => Promise<void>;
  stopReading: () => void;
}>;

/**
 * The Android scanner's reading (FR-621): one session after another until a tag is read. NFC switched off says so and
 * waits for the app to come back to the front, then reads again (CTO minor 4). Answers the stop for the screen to call.
 */
export function tapLoop(deps: TapLoopDeps): () => void {
  const run = { on: true };
  let waiting: ActiveWait | undefined;
  void (async () => {
    while (run.on) {
      const read = await deps.read();
      if (!run.on || read.kind === "unsupported") {
        return;
      }
      if (read.kind === "read") {
        deps.onRead(read);
        return;
      }
      if (read.kind === "off") {
        deps.onOff(true);
        waiting = deps.untilActive();
        await waiting.done;
        waiting = undefined;
        if (!run.on) {
          return;
        }
        deps.onOff(false);
        continue;
      }
      await deps.pause(500);
    }
  })();
  return () => {
    run.on = false;
    waiting?.cancel();
    deps.stopReading();
  };
}
