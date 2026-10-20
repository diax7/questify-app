import { join } from "node:path";

/** Where the e2e API server writes the last sign-in code sent to each address. */
export const CODES_FILE = join(import.meta.dirname, "..", ".e2e", "codes.json");

/** The e2e API server's control port (test code only): it moves an event's status the way activation will (T-210). */
export const CONTROL_PORT = 4101;
