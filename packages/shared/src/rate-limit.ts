export type RateLimitState = Readonly<{ limit: number; remaining: number; resetSeconds: number }>;

/** The standard headers sent with every 429 and, where useful, with normal answers (docs/API.md). */
export function rateLimitHeaders(state: RateLimitState): Record<string, string> {
  return {
    "RateLimit-Limit": String(state.limit),
    "RateLimit-Remaining": String(Math.max(0, state.remaining)),
    "RateLimit-Reset": String(Math.ceil(state.resetSeconds)),
  };
}
