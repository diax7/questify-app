import { asSouvenirSystem, paySouvenirs } from "#src/souvenirs/payer";
import type { SouvenirDeps } from "#src/souvenirs/souvenirs";

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
        const { rows } = await client.query<{
          health: { due: number; failed: number; oldestAt: string | null };
        }>("SELECT souvenir_health() AS health");
        return rows[0]?.health;
      });
      if (
        totals.failed > 0 ||
        (health?.failed ?? 0) > 0 ||
        (health?.oldestAt !== null &&
          health?.oldestAt !== undefined &&
          Date.now() - Date.parse(health.oldestAt) > 60_000)
      ) {
        deps.log({ event: "souvenir.pending", ...totals, due: health?.due ?? 0 });
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
        running = run();
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
