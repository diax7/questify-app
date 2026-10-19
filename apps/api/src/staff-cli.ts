import { Client } from "pg";
import { createAuthKeys } from "./auth/keys";
import { clearThrottleFor, createStaffAccount } from "./auth/staff-admin";

/**
 * One-off staff account administration, run inside the app container with the owner's database connection.
 *   create <email> [--admin]   make an account; the password is read from standard input, never from arguments
 *   clear-throttle <email>     let a person who is throttled try again (needs AUTH_SECRET)
 */
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

async function main(): Promise<void> {
  const [command, email, ...flags] = process.argv.slice(2);
  if (email === undefined || (command !== "create" && command !== "clear-throttle")) {
    throw new Error("Usage: staff create <email> [--admin]  |  staff clear-throttle <email>");
  }
  const owner = new Client({ connectionString: need("DATABASE_ADMIN_URL") });
  await owner.connect();
  try {
    if (command === "create") {
      const id = await createStaffAccount(owner, {
        email,
        password: await readStdin(),
        admin: flags.includes("--admin"),
      });
      process.stdout.write(`Created ${email} (${id}).\n`);
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
