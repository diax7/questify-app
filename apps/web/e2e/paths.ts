import { join } from "node:path";

/** Where the e2e API server writes the last sign-in code sent to each address. */
export const CODES_FILE = join(import.meta.dirname, "..", ".e2e", "codes.json");

/** The e2e API server's control port (test code only): it moves an event's status the way activation will (T-210). */
export const CONTROL_PORT = 4101;

/**
 * The second server pair (T-810d): the same web build with the console on its own host, and its own e2e API with
 * `CONSOLE_ORIGIN` set, database, codes file and control port. Only `console-host.spec.ts` uses it; every other spec
 * runs on the one-host pair above, which is the app with no console host configured.
 */
export const SPLIT_WEB_PORT = 3102;
export const SPLIT_API_PORT = 4102;
export const SPLIT_CONTROL_PORT = 4103;
export const SPLIT_WEB_ORIGIN = `http://localhost:${SPLIT_WEB_PORT}`;
export const SPLIT_CONSOLE_ORIGIN = `http://console.localhost:${SPLIT_WEB_PORT}`;
export const SPLIT_CODES_FILE = join(import.meta.dirname, "..", ".e2e", "codes-console.json");
