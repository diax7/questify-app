const DAY_MS = 24 * 60 * 60 * 1000;

export type BeginResult =
  | { kind: "new" }
  | { kind: "replay"; status: number; payload: string; contentType: string }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

/** Remembers the first answer to an action for 24 hours so a retry can never run it twice. */
export interface IdempotencyStore {
  begin(scope: string, key: string, requestHash: string): Promise<BeginResult>;
  finish(
    scope: string,
    key: string,
    status: number,
    payload: string,
    contentType: string,
  ): Promise<void>;
  abort(scope: string, key: string): Promise<void>;
}

type Entry =
  | { state: "in_progress"; hash: string; expiresAt: number }
  | {
      state: "done";
      hash: string;
      expiresAt: number;
      status: number;
      payload: string;
      contentType: string;
    };

/** In-memory store for tests and local use. The shared database version arrives with T-003. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(scope: string, key: string, requestHash: string): Promise<BeginResult> {
    const id = `${scope}\u0000${key}`;
    const existing = this.entries.get(id);
    if (existing !== undefined && existing.expiresAt > this.now()) {
      if (existing.hash !== requestHash) {
        return Promise.resolve({ kind: "mismatch" });
      }
      if (existing.state === "in_progress") {
        return Promise.resolve({ kind: "in_progress" });
      }
      return Promise.resolve({
        kind: "replay",
        status: existing.status,
        payload: existing.payload,
        contentType: existing.contentType,
      });
    }
    this.entries.set(id, {
      state: "in_progress",
      hash: requestHash,
      expiresAt: this.now() + DAY_MS,
    });
    return Promise.resolve({ kind: "new" });
  }

  finish(
    scope: string,
    key: string,
    status: number,
    payload: string,
    contentType: string,
  ): Promise<void> {
    const id = `${scope}\u0000${key}`;
    const existing = this.entries.get(id);
    if (existing !== undefined) {
      this.entries.set(id, {
        state: "done",
        hash: existing.hash,
        expiresAt: existing.expiresAt,
        status,
        payload,
        contentType,
      });
    }
    return Promise.resolve();
  }

  abort(scope: string, key: string): Promise<void> {
    this.entries.delete(`${scope}\u0000${key}`);
    return Promise.resolve();
  }
}
