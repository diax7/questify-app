import { describe, expect, it } from "vitest";
import { rateLimitHeaders } from "./rate-limit";

describe("rateLimitHeaders", () => {
  it("returns the three standard headers as text", () => {
    expect(rateLimitHeaders({ limit: 60, remaining: 59, resetSeconds: 12 })).toEqual({
      "RateLimit-Limit": "60",
      "RateLimit-Remaining": "59",
      "RateLimit-Reset": "12",
    });
  });

  it("never reports less than zero remaining", () => {
    expect(
      rateLimitHeaders({ limit: 5, remaining: -2, resetSeconds: 1 })["RateLimit-Remaining"],
    ).toBe("0");
  });

  it("rounds the reset up to a whole second", () => {
    expect(rateLimitHeaders({ limit: 5, remaining: 1, resetSeconds: 1.2 })["RateLimit-Reset"]).toBe(
      "2",
    );
  });
});
