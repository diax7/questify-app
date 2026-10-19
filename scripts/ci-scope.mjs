// Decides which heavier CI steps a change needs, from the files it touches (CI budget rules: scope by changed files).
// Prints `web=true|false` and `e2e=true|false` lines for $GITHUB_OUTPUT.
// Usage: node scripts/ci-scope.mjs <base-ref-or-sha>
// When the base is missing or unknown (first push, force push), everything runs: never skip on doubt.
import { execFileSync } from "node:child_process";

const WEB = [
  /^apps\/web\//,
  /^packages\/shared\//,
  /^pnpm-lock\.yaml$/,
  /^\.github\/workflows\//,
  /^scripts\/ci-scope\.mjs$/,
];
// The browser tests boot the whole API in-process, so any API source or migration change can break sign-in.
const E2E = [
  ...WEB,
  /^apps\/api\/src\//,
  /^apps\/api\/migrations\//,
  /^apps\/api\/test\/(support|e2e-server)/,
];

function changedFiles(base) {
  if (base === undefined || base === "" || /^0+$/.test(base)) {
    return undefined;
  }
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf8",
    });
    return output.split("\n").filter((line) => line !== "");
  } catch {
    return undefined;
  }
}

const files = changedFiles(process.argv[2]);
const touches = (patterns) =>
  files === undefined || files.some((file) => patterns.some((pattern) => pattern.test(file)));
process.stdout.write(`web=${touches(WEB)}\ne2e=${touches(E2E)}\n`);
