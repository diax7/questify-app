import { join } from "node:path";

/** Where the e2e API server writes the last sign-in code sent to each address. */
export const CODES_FILE = join(import.meta.dirname, "..", ".e2e", "codes.json");
