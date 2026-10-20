import { defineConfig, devices } from "@playwright/test";
import { CODES_FILE, CONTROL_PORT } from "#e2e/paths.ts";

/**
 * Browser tests of the dashboard sign-in (T-011) against the real API on a throw-away database. The API server is
 * test code in apps/api/test/e2e-server.ts, bundled by `pnpm e2e`; codes reach the tests through CODES_FILE.
 * Needs TEST_DATABASE_URL and a built web app (`next build`).
 */
const WEB_PORT = 3100;
const API_PORT = 4100;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: ".e2e/results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env["CI"] !== undefined,
  reporter: process.env["CI"] === undefined ? "list" : "github",
  use: { baseURL: WEB_ORIGIN, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // A small phone screen (FR-1746): the layout must work at 360 px without sideways scrolling.
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } } },
  ],
  webServer: [
    {
      command: "node ../api/test/support/e2e-server.bundle.mjs",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      env: {
        ...process.env,
        E2E_API_PORT: String(API_PORT),
        E2E_WEB_ORIGIN: WEB_ORIGIN,
        E2E_CODES_FILE: CODES_FILE,
        E2E_CONTROL_PORT: String(CONTROL_PORT),
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The standalone server the Docker image runs, so the tests cover what ships.
      command: "pnpm start",
      url: `${WEB_ORIGIN}/en/sign-in`,
      env: {
        ...process.env,
        API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
        PORT: String(WEB_PORT),
        HOSTNAME: "localhost",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
