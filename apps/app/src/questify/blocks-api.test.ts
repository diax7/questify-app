import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { readBlocks, setBlocked } from "#src/questify/blocks-api.ts";

const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const session = (answer: AuthedResult) => ({ request: vi.fn().mockResolvedValue(answer) });

describe("the block list's calls (T-705)", () => {
  it("reads the list, and nothing from a changed or failed answer", async () => {
    const blocks = [{ username: "sara", avatar: "fox", blockedAt: "2026-11-02T10:00:00Z" }];
    expect(await readBlocks(session(ok({ blocks })))).toEqual(blocks);
    expect(await readBlocks(session(ok({ blocks: [{ username: 1 }] })))).toBeNull();
    expect(await readBlocks(session({ kind: "network" } as AuthedResult))).toBeNull();
  });

  it("blocks in the body and unblocks in the path, each with its own key", async () => {
    const calls = session(ok(undefined));
    expect(await setBlocked(calls, "sara k", true)).toBe(true);
    expect(await setBlocked(calls, "sara k", false)).toBe(true);
    const [block, unblock] = calls.request.mock.calls.map((call) => call[0]);
    expect(block).toMatchObject({
      method: "POST",
      path: "/v1/me/blocks",
      body: { username: "sara k" },
    });
    expect(unblock).toMatchObject({ method: "DELETE", path: "/v1/me/blocks/sara%20k" });
    expect(block.headers["idempotency-key"]).not.toBe(unblock.headers["idempotency-key"]);
    expect(await setBlocked(session({ kind: "network" } as AuthedResult), "sara", true)).toBe(
      false,
    );
  });
});
