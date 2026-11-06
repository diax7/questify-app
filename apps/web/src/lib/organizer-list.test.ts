import { describe, expect, it } from "vitest";
import type { OrganizerRow } from "#src/lib/console-organizers.ts";
import {
  FIRST_LOAD,
  readOrganizers,
  type OrganizerList,
  type OrganizerReply,
} from "#src/lib/organizer-list.ts";

const row = (id: string): OrganizerRow => ({
  id,
  name: id,
  slug: id,
  status: "active",
  ownerEmail: null,
  events: { draft: 0, scheduled: 0, live: 0 },
});
const page = (ids: string[], nextCursor: string | null = null): OrganizerReply => ({
  page: { organizers: ids.map(row), nextCursor },
});

/** A list holder with the setter the component passes, and replies the test releases by hand. */
function harness() {
  const state = { list: FIRST_LOAD as OrganizerList, guard: { latest: 0 } };
  const setList = (update: (list: OrganizerList) => OrganizerList) => {
    state.list = update(state.list);
  };
  const pending: ((reply: OrganizerReply) => void)[] = [];
  const fetchPage = () => new Promise<OrganizerReply>((resolve) => pending.push(resolve));
  const read = (cursor: string | null) => readOrganizers(state.guard, fetchPage, setList, cursor);
  return { state, pending, read };
}

const ids = (list: OrganizerList) => list.rows?.map((r) => r.id);

describe("readOrganizers (T-701)", () => {
  it("shows loading with no rows, then the first page", async () => {
    const { state, pending, read } = harness();
    const done = read(null);
    expect(state.list).toMatchObject({ rows: null, loading: true, problem: null });
    pending[0]?.(page(["a", "b"], "c1"));
    await done;
    expect(ids(state.list)).toEqual(["a", "b"]);
    expect(state.list).toMatchObject({ next: "c1", loading: false });
  });

  it("appends a later page and keeps the rows while it loads", async () => {
    const { state, pending, read } = harness();
    const first = read(null);
    pending[0]?.(page(["a"], "c1"));
    await first;
    const more = read("c1");
    expect(ids(state.list)).toEqual(["a"]);
    expect(state.list.loading).toBe(true);
    pending[1]?.(page(["b"]));
    await more;
    expect(ids(state.list)).toEqual(["a", "b"]);
    expect(state.list.next).toBeNull();
  });

  it("drops an older reply that arrives after a newer search", async () => {
    const { state, pending, read } = harness();
    const older = read(null);
    const newer = read(null);
    pending[1]?.(page(["new"]));
    await newer;
    pending[0]?.(page(["old"], "stale"));
    await older;
    expect(ids(state.list)).toEqual(["new"]);
    expect(state.list).toMatchObject({ next: null, loading: false });
  });

  it("drops an older reply that arrives before the newer one and keeps loading", async () => {
    const { state, pending, read } = harness();
    const older = read(null);
    const newer = read(null);
    pending[0]?.(page(["old"]));
    await older;
    expect(state.list).toMatchObject({ rows: null, loading: true });
    pending[1]?.(page(["new"]));
    await newer;
    expect(ids(state.list)).toEqual(["new"]);
  });

  it("drops a stale load-more page after a new search", async () => {
    const { state, pending, read } = harness();
    const first = read(null);
    pending[0]?.(page(["a"], "c1"));
    await first;
    const more = read("c1");
    const search = read(null);
    pending[2]?.(page(["x"]));
    await search;
    pending[1]?.(page(["b"]));
    await more;
    expect(ids(state.list)).toEqual(["x"]);
  });

  it("shows a problem and keeps the rows already read when a later page fails", async () => {
    const { state, pending, read } = harness();
    const first = read(null);
    pending[0]?.(page(["a"], "c1"));
    await first;
    const more = read("c1");
    pending[1]?.({ problem: "offline" });
    await more;
    expect(ids(state.list)).toEqual(["a"]);
    expect(state.list).toMatchObject({ problem: "offline", loading: false, next: "c1" });
  });

  it("clears an earlier problem when the next read succeeds", async () => {
    const { state, pending, read } = harness();
    const failed = read(null);
    pending[0]?.({ problem: "offline" });
    await failed;
    expect(state.list).toMatchObject({ rows: null, problem: "offline" });
    const retry = read(null);
    expect(state.list.problem).toBeNull();
    pending[1]?.(page([]));
    await retry;
    expect(state.list).toMatchObject({ rows: [], problem: null, loading: false });
  });
});
