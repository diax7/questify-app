import type { Pool } from "pg";
import {
  asTeam,
  communityPlatformOn,
  type CommunityDeps,
  type CommunityDone,
} from "#src/community/goals";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

/** Rows one batch pays (ADR-223). */
export const BATCH_SIZE = 500;
/** How long the owner's "Settle and pay now" pays before it answers `paying` (ADR-226). */
export const SETTLE_PAY_BUDGET_MS = 20_000;

export type PayTotals = Readonly<{ batches: number; paid: number; skipped: number }>;

type BatchRow = { step_id: string; paid: number; skipped: number };

/**
 * Pays due community rewards in batches, each its own transaction in the system context (no identity, so the payer's
 * CS403 passes), until nothing is due or `budgetMs` is spent; only `onlyEvent`'s when given. A failed batch rolls
 * back whole and stays due; its error reaches the caller.
 */
export async function payBatches(
  pool: Pool,
  options: Readonly<{ budgetMs: number; onlyEvent?: string; now?: () => number }>,
): Promise<PayTotals> {
  const now = options.now ?? Date.now;
  const started = now();
  let totals = { batches: 0, paid: 0, skipped: 0 };
  while (now() - started < options.budgetMs) {
    const rows = await withConnection(pool, (client) =>
      withRequestContext(client, {}, async () => {
        const result = await client.query<BatchRow>("SELECT * FROM pay_community_batch($1, $2)", [
          BATCH_SIZE,
          options.onlyEvent ?? null,
        ]);
        return result.rows;
      }),
    );
    const batch = rows[0];
    if (batch === undefined) {
      break;
    }
    totals = {
      batches: totals.batches + 1,
      paid: totals.paid + Number(batch.paid),
      skipped: totals.skipped + Number(batch.skipped),
    };
  }
  return totals;
}

/** Where an event's community rewards stand after the owner's settle. */
export type SettleAnswer = Readonly<{
  /** `paid` once nothing is due; `paying` asks the dashboard to call again. */
  status: "paid" | "paying";
  /** Goals not final yet (still running, or none of them ended). */
  goals: number;
  due: number;
}>;

/**
 * The owner's "Settle and pay now" (ADR-226, CTO 5): settles every goal of the event whose window ended up to the
 * oldest open transaction (`settling` while one from a window is open), then pays the event's due rewards for up to
 * 20 s in the system context (the owner's identity is cleared for the payer, CTO 8), and answers what is left.
 */
export async function settleAndPay(
  deps: CommunityDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; requestId: string }>,
  budgetMs = SETTLE_PAY_BUDGET_MS,
): Promise<CommunityDone<SettleAnswer>> {
  const mayStart = await communityPlatformOn(deps.settings);
  const settled = await asTeam(deps, context, async (client) => {
    await client.query("SELECT settle_community($1, $2, $3)", [
      request.eventId,
      mayStart,
      request.requestId,
    ]);
    return null;
  });
  if (settled.kind !== "done") {
    return settled;
  }
  await payBatches(deps.pool, { budgetMs, onlyEvent: request.eventId });
  const left = await asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ goals: string; due: string }>(
      "SELECT * FROM community_paying($1)",
      [request.eventId],
    );
    return { goals: Number(rows[0]?.goals ?? 0), due: Number(rows[0]?.due ?? 0) };
  });
  if (left.kind !== "done") {
    return left;
  }
  return {
    kind: "done",
    value: { status: left.value.due === 0 ? "paid" : "paying", ...left.value },
  };
}
