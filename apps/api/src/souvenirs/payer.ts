import type { PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { SouvenirDeps } from "#src/souvenirs/souvenirs";

type Claim = { event_id: string; enrollment_id: string; generation: string; lease_token: string };
export type SouvenirTotals = Readonly<{ granted: number; skipped: number; failed: number }>;
export const SOUVENIR_BUDGET_MS = 2000;
export const SOUVENIR_BATCH = 20;

export const asSouvenirSystem = <T>(deps: SouvenirDeps, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) => withRequestContext(client, {}, () => work(client)));

/** Claim, grant and acknowledge each commit separately; source writers never wait behind a queue-held grant. */
async function evaluateClaim(deps: SouvenirDeps, claim: Claim): Promise<SouvenirTotals> {
  let failure: string | null = null;
  let granted = 0;
  try {
    granted = await asSouvenirSystem(deps, async (client) => {
      const { rows } = await client.query<{ made: number }>(
        "SELECT souvenir_evaluate($1) AS made",
        [claim.enrollment_id],
      );
      return rows[0]?.made ?? 0;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    failure = code !== undefined && /^[A-Z0-9]{5}$/.test(code) ? code : "SV500";
  }
  await asSouvenirSystem(deps, (client) =>
    client.query("SELECT souvenir_ack($1,$2,$3,$4)", [
      claim.enrollment_id,
      claim.generation,
      claim.lease_token,
      failure,
    ]),
  );
  return {
    granted,
    skipped: failure === null && granted === 0 ? 1 : 0,
    failed: failure === null ? 0 : 1,
  };
}

/** At most500 recipients and a time budget per invocation. Unprocessed leases expire safely for another run. */
export async function paySouvenirs(
  deps: SouvenirDeps,
  options: Readonly<{ eventId?: string; budgetMs?: number; now?: () => number }> = {},
): Promise<SouvenirTotals> {
  const now = options.now ?? Date.now;
  const started = now();
  const totals = { granted: 0, skipped: 0, failed: 0 };
  let evaluated = 0;
  while (evaluated < 500 && now() - started < (options.budgetMs ?? SOUVENIR_BUDGET_MS)) {
    const claims = await asSouvenirSystem(deps, async (client) => {
      await client.query("SELECT souvenir_scan_batch($1)", [options.eventId ?? null]);
      const { rows } = await client.query<Claim>("SELECT * FROM souvenir_claim_work($1,$2)", [
        options.eventId ?? null,
        SOUVENIR_BATCH,
      ]);
      return rows;
    });
    if (claims.length === 0) break;
    for (const claim of claims) {
      if (now() - started >= (options.budgetMs ?? SOUVENIR_BUDGET_MS)) return totals;
      const result = await evaluateClaim(deps, claim);
      totals.granted += result.granted;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
      evaluated += 1;
    }
  }
  return totals;
}
