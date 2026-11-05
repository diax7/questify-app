import { userInfo } from "node:os";
import { Client } from "pg";
import { rewardCodeSettings, type Env } from "#src/config";
import { createRewardCodeKeyring } from "#src/rewards/codes";
import { checkCodes, resealCodes } from "#src/rewards/reseal";

export const REWARD_CODES_USAGE = "Usage: reward-codes reseal [--by <name>]  |  reward-codes check";

export type CommandIo = Readonly<{
  /** Writes one line of output. */
  print: (line: string) => void;
  /** Opens the owner connection; tests give one to the test database. */
  connect: (url: string) => Promise<Client>;
}>;

async function connectOwner(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

export const DEFAULT_IO: CommandIo = {
  print: (line) => process.stdout.write(`${line}\n`),
  connect: connectOwner,
};

function adminUrl(env: Env): string {
  const url = env["DATABASE_ADMIN_URL"];
  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_ADMIN_URL is not set: the re-seal runs on the owner connection.");
  }
  return url;
}

function operator(flags: readonly string[]): string {
  const at = flags.indexOf("--by");
  const by = (at === -1 ? userInfo().username : (flags[at + 1] ?? "")).trim();
  if (by === "") {
    throw new Error("The operator is empty: pass --by <name>.");
  }
  return by;
}

/**
 * `reward-codes.cjs` (T-810f, ADR-728), run inside the API container with the API's reward code settings and the
 * owner's connection:
 *   reseal [--by <name>]   seal every code again under the current key; exit 0 when nothing is left to do
 *   check                  with only the current key, prove every code opens; exit 0 when all do
 * The settings are read and refused exactly as the API reads them (`rewardCodeSettings`), before any connection.
 * Prints one JSON line of counts and row ids, never a code, cipher or mark.
 *
 * @returns the process exit code.
 * @throws Error with the usage, a refused setting, or a stopped run's row id and SQLSTATE.
 */
export async function runRewardCodesCommand(
  argv: readonly string[],
  env: Env,
  io: CommandIo = DEFAULT_IO,
): Promise<number> {
  const [command, ...flags] = argv;
  if (command !== "reseal" && command !== "check") {
    throw new Error(REWARD_CODES_USAGE);
  }
  const ring = createRewardCodeKeyring(rewardCodeSettings(env));
  const by = command === "reseal" ? operator(flags) : "";
  const owner = await io.connect(adminUrl(env));
  try {
    if (command === "check") {
      const report = await checkCodes(owner, ring);
      io.print(JSON.stringify({ command, keyId: ring.current.id, ...report }));
      return report.stale === 0 ? 0 : 1;
    }
    const report = await resealCodes(owner, ring, { by });
    io.print(JSON.stringify({ command, keyId: ring.current.id, ...report }));
    return report.unreadable + report.conflict + report.changed === 0 ? 0 : 1;
  } finally {
    await owner.end();
  }
}
