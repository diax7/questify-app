import { describe, expect, it } from "vitest";
import { isLocalServer } from "#test/load/local-server";

describe("isLocalServer", () => {
  it.each([
    "postgres://u:p@127.0.0.1:55432/postgres",
    "postgres://u:p@localhost/postgres",
    "postgres://u:p@[::1]:5432/postgres",
  ])("accepts %s", (url) => {
    expect(isLocalServer(url)).toBe(true);
  });

  it.each([
    "postgres://u:p@127.0.0.1/postgres?host=evil.com",
    "postgres://u:p@127.0.0.1.evil.com/postgres",
    "postgres://localhost@evil.com/postgres",
    "postgres://u:p@db.example.com/postgres",
    "postgres://u:p@127.0.0.1/postgres?host=/var/run/postgresql",
  ])("refuses %s", (url) => {
    expect(isLocalServer(url)).toBe(false);
  });
});
