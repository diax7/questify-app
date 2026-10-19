import { buildApp } from "./app";
import { loadConfig } from "./config";
import { MemoryIdempotencyStore } from "./idempotency-store";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // One instance for now, so remembering keys in memory is enough. The database-backed store arrives with T-003.
  const app = buildApp({ config, idempotencyStore: new MemoryIdempotencyStore() });

  const stop = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Could not start the API: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
