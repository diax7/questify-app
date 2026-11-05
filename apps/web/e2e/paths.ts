import { join } from "node:path";

/** Where the e2e API server writes the last sign-in code sent to each address. */
export const CODES_FILE = join(import.meta.dirname, "..", ".e2e", "codes.json");

/** The public host the browser tests open (the dashboard, event pages, sign-in). */
export const WEB_ORIGIN = "http://localhost:3100";
/**
 * The console's own host (T-810d, ADR-724): Chromium resolves `*.localhost` to the loopback address and treats it as
 * secure, so the `__Host-` session cookie works over http. It is a different host, so it has its own cookie jar.
 */
export const CONSOLE_ORIGIN = "http://console.localhost:3100";

/** The e2e API server's control port (test code only): it moves an event's status the way activation will (T-210). */
export const CONTROL_PORT = 4101;
