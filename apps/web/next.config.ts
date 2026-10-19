import { join } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // A self-contained server for the Docker image (apps/web/Dockerfile); traced from the repository root because
  // the shared package and the fonts live outside apps/web.
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  // No image optimiser on the server (and so no `sharp`): nothing needs resized images yet.
  images: { unoptimized: true },
  // The shared package ships TypeScript sources.
  transpilePackages: ["@questify/shared"],
  // Next's own type pass needs the TypeScript 5 JS API, which the repo's TypeScript 7 does not have. Types are
  // checked by `pnpm typecheck` (tsc 7) in CI instead (T-011 plan, M2).
  typescript: { ignoreBuildErrors: true },
};

export default config;
