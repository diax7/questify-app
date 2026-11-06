import type { OrganizerRow } from "#src/lib/console-organizers.ts";

/** What the console's organizer list shows: the rows read so far (null before the first page), the cursor, a problem. */
export type OrganizerList = Readonly<{
  rows: readonly OrganizerRow[] | null;
  next: string | null;
  problem: string | null;
  loading: boolean;
}>;

export const FIRST_LOAD: OrganizerList = { rows: null, next: null, problem: null, loading: true };

/** One read of the list: a page, or the words of the problem that stopped it. */
export type OrganizerReply = Readonly<
  | { page: Readonly<{ organizers: OrganizerRow[]; nextCursor: string | null }> }
  | { problem: string }
>;

/** A read starts: a first page (no cursor) empties the list, a later page keeps it. */
export function startRead(list: OrganizerList, cursor: string | null): OrganizerList {
  return cursor === null ? FIRST_LOAD : { ...list, loading: true };
}

/** A read ends: a page replaces the list (first page) or extends it; a problem keeps the rows already read. */
export function endRead(
  list: OrganizerList,
  cursor: string | null,
  reply: OrganizerReply,
): OrganizerList {
  if ("problem" in reply) return { ...list, loading: false, problem: reply.problem };
  return {
    rows:
      cursor === null ? reply.page.organizers : [...(list.rows ?? []), ...reply.page.organizers],
    next: reply.page.nextCursor,
    problem: null,
    loading: false,
  };
}

/**
 * Starts a read and applies its reply only while it is the newest one: a slower, older reply (an earlier search, or a
 * page of an earlier filter) is dropped, so it never overwrites what the person asked for last. `guard` must outlive
 * the reads, since a new search makes a new `fetchPage`.
 */
export async function readOrganizers(
  guard: { latest: number },
  fetchPage: (cursor: string | null) => Promise<OrganizerReply>,
  setList: (update: (list: OrganizerList) => OrganizerList) => void,
  cursor: string | null,
): Promise<void> {
  guard.latest += 1;
  const mine = guard.latest;
  setList((list) => startRead(list, cursor));
  const reply = await fetchPage(cursor);
  if (mine !== guard.latest) return;
  setList((list) => endRead(list, cursor, reply));
}
