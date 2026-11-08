import { describe, expect, it } from "vitest";
import {
  APPLY_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
  forwardTimeoutMs,
} from "#src/lib/forward-timeout.ts";
import {
  APPLY_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EXPORT_REQUEST_TIMEOUT_MS,
} from "#src/lib/post-json.ts";

const EVENT = "/v1/organizers/o1/events/e1";

describe("forwardTimeoutMs", () => {
  it("gives an export and a change-set apply their long limits", () => {
    expect(forwardTimeoutMs(`${EVENT}/exports/players`)).toBe(EXPORT_TIMEOUT_MS);
    expect(forwardTimeoutMs(`${EVENT}/change-sets/s1/apply`)).toBe(APPLY_TIMEOUT_MS);
  });

  it.each([
    `${EVENT}/change-sets/s1/close`,
    `${EVENT}/change-sets/s1`,
    `${EVENT}/change-sets/s1/apply/extra`,
    `${EVENT}/exports/players/extra`,
    "/v1/staff/me",
  ])("keeps %s at the default", (path) => {
    expect(forwardTimeoutMs(path)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("leaves the browser waiting longer than the forwarder on every path", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    expect(EXPORT_REQUEST_TIMEOUT_MS).toBeGreaterThan(EXPORT_TIMEOUT_MS);
    expect(APPLY_REQUEST_TIMEOUT_MS).toBeGreaterThan(APPLY_TIMEOUT_MS);
  });
});
