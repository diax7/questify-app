import { testConfig } from "#test/support/auth-app";

/**
 * The setting `name` from the environment.
 *
 * @throws Error when it is not set, naming it.
 */
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the load test (docs/RUNBOOK.md, "Load test").`);
  }
  return value;
}

/** The QR secret the plan signs quest codes with and the load API checks them with: the tests' one unless set. */
export function qrSecret(): string {
  return process.env["LOAD_QR_SECRET"] ?? testConfig().qrSecret;
}
