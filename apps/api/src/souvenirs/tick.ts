import { asSouvenirSystem, paySouvenirs } from "#src/souvenirs/payer";
import type { SouvenirDeps } from "#src/souvenirs/souvenirs";
import { trackRun } from "#src/telemetry/runs";

type Health = Readonly<{ due: number; failed: number; held: number; oldestAt: string | null }>;
const EMPTY: Health = { due: 0, failed: 0, held: 0, oldestAt: null };

/**
 * Whether the queue has failed work or work that waited more than a minute. Work held by a suspended event is outside
 * `failed`, `due` and `oldestAt` (migration 0190): it waits for the lift and is not reported on its own, or a
 * suspension would log every run.
 */
const behind = (health: Health): boolean =>
  health.failed > 0 ||
  (health.oldestAt !== null && Date.now() - Date.parse(health.oldestAt) > 60_000);

/** Jittered, non-overlapping batches; failures stay durable for the next run. No names/content in logs. */
export function startSouvenirTick(
  deps: SouvenirDeps & {
    intervalMs: number;
    log: (fields: Record<string, unknown>) => void;
    random?: () => number;
  },
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const run = async () => {
    try {
      const totals = await paySouvenirs(deps);
      const health = await asSouvenirSystem(deps, async (client) => {
        const { rows } = await client.query<{ health: Health }>(
          "SELECT souvenir_health() AS health",
        );
        return rows[0]?.health ?? EMPTY;
      });
      if (totals.failed > 0 || behind(health)) {
        deps.log({ event: "souvenir.pending", ...totals, due: health.due, held: health.held });
      }
    } catch (error) {
      deps.log({
        event: "souvenir.tick_failed",
        code: (error as { code?: string }).code ?? "SV500",
      });
    } finally {
      if (!stopped) schedule();
    }
  };
  const schedule = () => {
    timer = setTimeout(
      () => {
        running = trackRun("souvenir", run);
      },
      deps.intervalMs * (0.8 + (deps.random ?? Math.random)() * 0.4),
    );
    timer.unref();
  };
  schedule();
  return {
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
