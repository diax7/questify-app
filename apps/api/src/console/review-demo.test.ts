import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { createReviewDemo, prepareReviewDemo } from "#src/console/review-demo";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const ADMIN = { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" };
const KEYS = createAuthKeys("a-test-secret-that-is-long-enough-for-review");
const CREATE = { phone: "+966500000720", requestId: "r" };

/** Create through a pool whose create door throws `failure`. */
const createFailing = (failure: Error) =>
  createReviewDemo(
    fakePool(() => {
      throw failure;
    }).pool,
    KEYS,
    ADMIN,
    CREATE,
  );

describe("the review demo doors' refusals (T-710)", () => {
  it("answers each review demo SQLSTATE with its own refusal", async () => {
    await expect(createFailing(pgError({ code: "RD404" }))).rejects.toMatchObject({
      status: 404,
      envelope: { code: "not_found" },
    });
    await expect(
      createFailing(pgError({ code: "RD400", detail: "contact" })),
    ).rejects.toMatchObject({
      status: 422,
      envelope: { code: "invalid_review_demo", details: { field: "contact" } },
    });
    await expect(
      createFailing(pgError({ code: "RD409", detail: "contact_held" })),
    ).rejects.toMatchObject({ envelope: { code: "contact_held" } });
    await expect(
      createFailing(pgError({ code: "RD409", detail: "unheard_of" })),
    ).rejects.toMatchObject({ status: 409, envelope: { code: "review_demo_stale" } });
  });

  it("asks the admin to try again when a deletion of the reviewer holds the lock", async () => {
    await expect(createFailing(pgError({ code: "55P03" }))).rejects.toMatchObject({
      status: 409,
      envelope: { code: "review_demo_stale" },
    });
  });

  it("passes any other failure through unchanged", async () => {
    const failure = pgError({ code: "XX000" });
    await expect(createFailing(failure)).rejects.toBe(failure);
  });

  it("answers 404 to Prepare before Create and never reaches the prepare door", async () => {
    const { pool, queries } = fakePool((): FakeAnswer => ({ rows: [{ r: { exists: false } }] }));
    await expect(
      prepareReviewDemo(pool, KEYS, ADMIN, { days: 7, version: "1.0", requestId: "r" }),
    ).rejects.toMatchObject({ status: 404, envelope: { code: "not_found" } });
    expect(queries.some((sql) => sql.includes("console_review_demo_prepare"))).toBe(false);
  });
});
