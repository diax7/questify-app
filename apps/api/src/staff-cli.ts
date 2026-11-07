import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { Client } from "pg";
import { createEmailSender } from "#src/auth/email/from-config";
import { createAuthKeys } from "#src/auth/keys";
import {
  clearThrottleFor,
  createOutcome,
  createStaffAccount,
  setPlatformAdmin,
  type InviteMail,
} from "#src/auth/staff-admin";
import { authConfig } from "#src/config";
import { erasedIdsFrom, reapplyErasures } from "#src/privacy/reapply";

/**
 * One-off staff account administration, run inside the app container with the owner's database connection.
 *   create <email>             make an account with no platform role and mail its set-password link (needs the mail
 *                              settings); it takes no password and no flags, and never reads standard input
 *   clear-throttle <email>     let a person who is throttled try again (needs AUTH_SECRET)
 *   grant-admin <email> --reason "why" [--by <name>]    make an existing account a Questify platform admin (ADR-405)
 *   revoke-admin <email> --reason "why" [--by <name>]   take the role away; ends the account's sessions and grants
 *   reapply-erasures <file>    after a database restore, erase again every account erased since the backup (ADR-484):
 *                              the file holds `player.deleted` log lines and/or player ids, one per line
 * The reason is required; the operator is --by, else the operating-system user. Both go in the audit entry.
 */
const COMMANDS = [
  "create",
  "clear-throttle",
  "grant-admin",
  "revoke-admin",
  "reapply-erasures",
] as const;
const USAGE =
  'Usage: staff create <email>  |  staff clear-throttle <email>  |  staff grant-admin <email> --reason "why" [--by <name>]  |  staff revoke-admin <email> --reason "why" [--by <name>]  |  staff reapply-erasures <file>';

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

/** Read before anything is written, so missing mail settings refuse with nothing made. */
function inviteMail(): InviteMail {
  const auth = authConfig(process.env);
  return { email: createEmailSender(auth), dashboardOrigin: auth.dashboardOrigin };
}

/**
 * The command line, refused with the usage text; `create` takes no flags, so an old `--admin` cannot pass quietly, and
 * an email that starts with `-` is a flag in the wrong place, never an address.
 */
function parseArguments(args: readonly string[]) {
  const [command, email, ...flags] = args;
  const known = (COMMANDS as readonly (string | undefined)[]).includes(command);
  if (command === undefined || email === undefined || !known || email.startsWith("-")) {
    throw new Error(USAGE);
  }
  if (command === "create" && flags.length > 0) {
    throw new Error(USAGE);
  }
  return { command, email, flags };
}

/** Every command but `create`, on the open owner connection. */
async function runCommand(
  owner: Client,
  command: string,
  email: string,
  flags: readonly string[],
): Promise<void> {
  if (command === "reapply-erasures") {
    const counts = await reapplyErasures(owner, erasedIdsFrom(await readFile(email, "utf8")));
    process.stdout.write(
      `Erased again: ${counts.erased}; already deleted: ${counts.alreadyDeleted}; not in this database: ${counts.unknown}.
`,
    );
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
}

async function main(): Promise<void> {
  const { command, email, flags } = parseArguments(process.argv.slice(2));
  const mail = command === "create" ? inviteMail() : undefined;
  const owner = new Client({ connectionString: need("DATABASE_ADMIN_URL") });
  await owner.connect();
  try {
    if (mail !== undefined) {
      const outcome = createOutcome(email, await createStaffAccount(owner, { email }, mail));
      process.stdout.write(`${outcome.text}\n`);
      process.exitCode = outcome.exitCode;
      return;
    }
    await runCommand(owner, command, email, flags);
  } finally {
    await owner.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
