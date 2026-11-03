import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { cancelOwnerEmailChange } from "#src/console/owner-email";

const ADMIN = { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" };
const CHANGE = "6f1d2b3c-4a5e-4f60-8a71-92b3c4d5e6f7";

/** A pool whose cancel door throws `failure`; every other statement succeeds with no rows. */
function failingPool(failure: Error): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("admin_owner_email_cancel")) throw failure;
    return { rows: [] };
  });
  return { connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
}

const pgError = (code: string, detail?: string) =>
  Object.assign(new Error("door"), { code, ...(detail === undefined ? {} : { detail }) });

describe("owner email doors", () => {
  it("turns an EC refusal into its HttpError, by code and detail or by code alone", async () => {
    const closed = failingPool(pgError("EC409", "not_pending"));
    await expect(
      cancelOwnerEmailChange({ pool: closed }, ADMIN, CHANGE, "r"),
    ).rejects.toMatchObject({
      envelope: { code: "email_change_closed" },
    });
    const missing = failingPool(pgError("EC404", "anything"));
    await expect(
      cancelOwnerEmailChange({ pool: missing }, ADMIN, CHANGE, "r"),
    ).rejects.toMatchObject({ envelope: { code: "not_found" } });
  });

  it("passes any other failure through unchanged", async () => {
    for (const failure of [pgError("XX000"), pgError("EC409", "unheard_of")]) {
      const pool = failingPool(failure);
      await expect(cancelOwnerEmailChange({ pool }, ADMIN, CHANGE, "r")).rejects.toBe(failure);
    }
  });
});
