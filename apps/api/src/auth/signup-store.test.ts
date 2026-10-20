import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withFreshSlug } from "#src/auth/signup-store";

function fakeDb() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return { db: { query } as unknown as PoolClient, query };
}

const slugs = () => {
  let n = 0;
  return () => `slug-${(n += 1)}`;
};

const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error("pg"), { code, constraint });

describe("withFreshSlug", () => {
  it("answers with the first try when the slug is free", async () => {
    const { db, query } = fakeDb();
    const create = vi.fn().mockResolvedValue("made");
    await expect(withFreshSlug(db, slugs(), create)).resolves.toBe("made");
    expect(create).toHaveBeenCalledExactlyOnceWith("slug-1");
    expect(query.mock.calls.map((call) => call[0])).toEqual(["SAVEPOINT organizer_slug"]);
  });

  it("rolls back to the savepoint and tries another slug when the slug was taken", async () => {
    const { db, query } = fakeDb();
    const create = vi
      .fn()
      .mockRejectedValueOnce(pgError("23505", "organizer_slug_key"))
      .mockResolvedValue("made");
    await expect(withFreshSlug(db, slugs(), create)).resolves.toBe("made");
    expect(create.mock.calls).toEqual([["slug-1"], ["slug-2"]]);
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      "SAVEPOINT organizer_slug",
      "ROLLBACK TO SAVEPOINT organizer_slug",
    ]);
  });

  it.each([
    ["another unique key", pgError("23505", "staff_user_email_key")],
    ["another error on the slug key", pgError("23514", "organizer_slug_key")],
    ["an error with no code", new Error("connection lost")],
  ])("passes %s through without a second try", async (_name, error) => {
    const { db, query } = fakeDb();
    const create = vi.fn().mockRejectedValue(error);
    await expect(withFreshSlug(db, slugs(), create)).rejects.toBe(error);
    expect(create).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });
});
