import { userInfo } from "node:os";
import { Client } from "pg";
import { createBreachCheck } from "#src/auth/breached";
import { createAuthKeys } from "#src/auth/keys";
import { clearThrottleFor, createStaffAccount, setPlatformAdmin } from "#src/auth/staff-admin";

/**
 * One-off staff account administration, run inside the app container with the owner's database connection.
 *   create <email> [--admin]   make an account; the password is read from standard input, never from arguments
 *   clear-throttle <email>     let a person who is throttled try again (needs AUTH_SECRET)
 *   grant-admin <email> --reason "why" [--by <name>]    make an existing account a Questify platform admin (ADR-405)
 *   revoke-admin <email> --reason "why" [--by <name>]   take the role away; ends the account's sessions and grants
 * The reason is required; the operator is --by, else the operating-system user. Both go in the audit entry.
 */
const COMMANDS = ["create", "clear-throttle", "grant-admin", "revoke-admin"] as const;
const USAGE =
  'Usage: staff create <email> [--admin]  |  staff clear-throttle <email>  |  staff grant-admin <email> --reason "why" [--by <name>]  |  staff revoke-admin <email> --reason "why" [--by <name>]';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

/** The value after a flag such as `--reason`, or undefined when the flag is absent or last. */
function flagValue(flags: readonly string[], name: string): string | undefined {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
}

/** grant-admin and revoke-admin (ADR-405): one transaction each, audited with who and why; says what changed. */
async function changeRole(
  owner: Client,
  email: string,
  granting: boolean,
  flags: readonly string[],
): Promise<void> {
  const note = {
    reason: flagValue(flags, "--reason") ?? "",
    by: flagValue(flags, "--by") ?? userInfo().username,
  };
  const change = await setPlatformAdmin(owner, email, granting, note);
  process.stdout.write(
    change.changed
      ? `${email}: platform admin ${granting ? "granted" : "revoked"} (sessions ended: ${change.sessionsEnded}, support grants closed: ${change.grantsClosed}).\n`
      : `${email} already had that role; nothing changed.\n`,
  );
}

async function main(): Promise<void> {
  const [command, email, ...flags] = process.argv.slice(2);
  if (email === undefined || !(COMMANDS as readonly (string | undefined)[]).includes(command)) {
    throw new Error(USAGE);
  }
  const owner = new Client({ connectionString: need("DATABASE_ADMIN_URL") });
  await owner.connect();
  try {
    if (command === "create") {
      const id = await createStaffAccount(
        owner,
        { email, password: await readStdin(), admin: flags.includes("--admin") },
        createBreachCheck(),
      );
      process.stdout.write(`Created ${email} (${id}).\n`);
      return;
    }
    if (command === "grant-admin" || command === "revoke-admin") {
      await changeRole(owner, email, command === "grant-admin", flags);
      return;
    }
    const found = await clearThrottleFor(owner, createAuthKeys(need("AUTH_SECRET")), email);
    process.stdout.write(
      found
        ? `Cleared the limits for ${email}.\n`
        : `No account for ${email}; cleared its failure count.\n`,
    );
  } finally {
    await owner.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
