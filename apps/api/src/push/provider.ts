/**
 * The one interface behind APNs and FCM (ADR-344): a provider per target, each send given a deadline it must answer by.
 * The real clients are `apns.ts` and `fcm.ts` (T-501b, built by `providers.ts` from the settings), the fake is `fake.ts`;
 * a platform without a provider sends nothing (its rows expire into the center).
 */

export const PUSH_TARGETS = ["apns:production", "apns:sandbox", "fcm"] as const;
export type PushTarget = (typeof PUSH_TARGETS)[number];

/** One message to one device, rendered and ready: the text is a fixed template, `data` holds ids only (ADR-346). */
export type PushMessage = Readonly<{
  token: string;
  /** The same on every attempt of one message (`n<notification id>`): a duplicate replaces the first on the phone. */
  collapseId: string;
  priority: "high" | "normal";
  expiresAt: Date;
  title: string;
  body: string;
  /** The Android channel: the kind's topic, `personal` or `offers`. */
  channel: string;
  /** Groups the event's pushes on iOS: the event id, or `questify`. */
  threadId: string;
  data: Readonly<Record<string, string>>;
}>;

/**
 * What one request came to (ADR-345 (4), plan § Review 3 and 4):
 * - `sent`: the provider accepted it.
 * - `unknown`: a timeout or a reset after the request was written; never sent again.
 * - `requeue`: a definite 5xx (`written: true`, counted) or a request never written (`written: false`, not counted);
 *   sent again by a later claim until it expires.
 * - `failed`: refused for this message; the token stays.
 * - `invalid_token`: the token is gone (`ambiguous` for the codes the mass-invalid guard counts).
 * - `hold`: an account or quota refusal; the target is held for `holdMs` and the row requeued with no attempt.
 */
export type PushResult =
  | Readonly<{ kind: "sent" }>
  | Readonly<{ kind: "unknown"; code: string }>
  | Readonly<{ kind: "requeue"; code: string; written: boolean; retryAfterMs?: number }>
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "invalid_token"; code: string; ambiguous: boolean }>
  | Readonly<{ kind: "hold"; code: string; holdMs: number }>;

export type PushProvider = Readonly<{
  target: PushTarget;
  /** Sends one message; answers by `deadline` (a timeout after writing is `unknown`). Never throws. */
  send: (message: PushMessage, deadline: Date) => Promise<PushResult>;
  close: () => Promise<void>;
}>;
