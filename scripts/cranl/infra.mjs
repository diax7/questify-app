// Questify's infrastructure on CranL as code (T-017, ADR-650; RUNBOOK "Infrastructure as code on CranL").
//   node scripts/cranl/infra.mjs plan <environment>    read-only: what apply would change, what a person must change
//                                                      in the dashboard, and what CranL has that the file does not say
//   node scripts/cranl/infra.mjs apply <environment>   creates and updates until CranL matches ops/cranl/<environment>.json
// Exit codes: 0 CranL matches the file; 2 there are changes (plan) or changes left for a person (apply); 1 an error.
// The API key comes from CRANL_API_KEY or the CranL CLI's sign-in. Operator secrets come from SECRET_<APP>_<NAME>.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { apply, describe, missingOperatorSecrets } from "./apply.mjs";
import { createClient, readApiKey } from "./client.mjs";
import { diff } from "./diff.mjs";
import { observe } from "./observe.mjs";
import { loadSpec } from "./spec.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const USAGE =
  "usage: node scripts/cranl/infra.mjs plan|apply <environment>   (a file in ops/cranl/)";

const writeLine = (line) => process.stdout.write(`${line}\n`);

function report(changes, env, print) {
  if (changes.length === 0) {
    print("No changes: CranL matches the file.");
    return 0;
  }
  for (const change of changes) print(describe(change));
  const missing = missingOperatorSecrets(changes, env);
  if (missing.length > 0) print(`apply needs these operator variables: ${missing.join(", ")}`);
  const manual = changes.filter((c) => c.sort !== "api").length;
  print(
    `${changes.length - manual} for apply, ${manual} for a person (RUNBOOK "Infrastructure as code on CranL").`,
  );
  return 2;
}

/**
 * Runs one command and returns the exit code.
 *
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>, fetch?: typeof fetch, root?: string,
 *   print?: (line: string) => void }} [options]
 */
export async function main(
  args,
  { env = process.env, fetch: doFetch = fetch, root = ROOT, print = writeLine } = {},
) {
  const [command, environment] = args;
  if (!["plan", "apply"].includes(command) || !/^[a-z]+$/.test(environment ?? "")) {
    print(USAGE);
    return 1;
  }
  const spec = loadSpec(join(root, "ops", "cranl", `${environment}.json`));
  const client = createClient({ apiKey: readApiKey(env), fetch: doFetch });
  if (command === "plan") return report(diff(spec, await observe(client, spec)), env, print);
  const { done, rest } = await apply({ client, spec, env, log: print });
  print(`apply made ${done} change(s).`);
  if (rest.length === 0) return 0;
  print("Left for a person:");
  for (const change of rest) print(describe(change));
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // process.exitCode, not process.exit(): exiting while fetch's sockets close aborts Node on Windows.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
