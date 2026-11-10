import { join } from "node:path";
import type { NextConfig } from "next";
import { STATIC_FILE_RULES } from "./src/lib/static-cache.ts";

const config: NextConfig = {
  poweredByHeader: false,
  // A self-contained server for the Docker image (Dockerfile.web at the repository root); traced from the repository root because
  // the shared package and the fonts live outside apps/web.
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  // The organizer documents are read from the repository's docs at request time (app/[lang]/legal).
  outputFileTracingIncludes: { "/[lang]/legal/[document]": ["../../docs/legal/organizer-*.md"] },
  // No image optimiser on the server (and so no `sharp`): nothing needs resized images yet.
  images: { unoptimized: true },
  // Long-lived cache headers for the files of `public/` (the pages stay `no-store`, from the proxy).
  headers: async () => STATIC_FILE_RULES.map((rule) => ({ ...rule, headers: [...rule.headers] })),
  // The player web build (T-803 P3, FR-1816): `expo export` writes a single-page app into `public/play` (Dockerfile.web,
  // `pnpm build:play`). Its files are served as they are (hashed scripts, pictures, fonts: a path with a dot); every other
  // path under `/play` is a screen of the app and gets the one `index.html`. `/play/index.html` itself goes to `/play`, so
  // the page is only ever served through the proxy's headers (its own CSP, `no-store`).
  rewrites: async () => [
    { source: "/play", destination: "/play/index.html" },
    { source: "/play/:path([^.]*)", destination: "/play/index.html" },
  ],
  redirects: async () => [{ source: "/play/index.html", destination: "/play", permanent: false }],
  // The shared package ships TypeScript sources.
  transpilePackages: ["@questify/shared"],
  // Next's own type pass needs the TypeScript 5 JS API, which the repo's TypeScript 7 does not have. Types are
  // checked by `pnpm typecheck` (tsc 7) in CI instead (T-011 plan, M2).
  typescript: { ignoreBuildErrors: true },
};

export default config;
