// Builds the player web app (T-803 P3, FR-1816) into apps/web/public/play, where the Next.js app serves it at /play.
// `expo export --platform web` reads apps/app (app.json: baseUrl /play, single-page output). The folder is emptied first,
// so a file of an older build never stays behind. Used by Dockerfile.web, CI and `pnpm --filter @questify/web build:play`.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps", "web", "public", "play");

rmSync(out, { recursive: true, force: true });
execFileSync(
  "pnpm",
  ["--filter", "@questify/app", "exec", "expo", "export", "--platform", "web", "--output-dir", out],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
  },
);
if (!existsSync(join(out, "index.html"))) {
  throw new Error(`expo export wrote no index.html into ${out}`);
}
