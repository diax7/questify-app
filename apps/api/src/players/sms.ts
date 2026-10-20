export type SmsMessage = Readonly<{ to: string; text: string }>;

/**
 * What became of one message. `unknown` (a timeout, an unreadable answer) means it may still arrive: the code stays
 * valid, and the sign-in screen's email offer after 30 seconds covers one that never does (T-107 plan, M7).
 */
export type SmsResult =
  | Readonly<{ kind: "sent" }>
  | Readonly<{ kind: "unknown"; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** A gateway that delivers a text to a phone. Behind this interface, switching gateways is configuration (ADR-103). */
export type SmsSender = Readonly<{
  name: string;
  send: (message: SmsMessage) => Promise<SmsResult>;
}>;

export type MsegatOptions = Readonly<{
  userName: string;
  apiKey: string;
  /** The activated services sender (codes and invites), never the `…AD` promotional one. */
  sender: string;
  /** Replaces the real network call in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

const ENDPOINT = "https://www.msegat.com/gw/sendsms.php";
const SUCCESS = new Set(["1", "M0000"]);
/** Network errors that prove the request never reached Msegat, so one retry cannot send the code twice. */
const NEVER_LEFT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

const causeCode = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
};

/**
 * Msegat's `sendsms.php` (INTEGRATIONS.md): JSON body with the account, the services sender, the number without `+`,
 * the text in UTF-8; success is code `1` or `M0000`. Five-second limit; one retry only when the request provably never
 * left (Msegat has no idempotency key, so a retry after a timeout could send the code twice). The text and the number
 * never reach a log or an error.
 */
export function createMsegatSender(options: MsegatOptions): SmsSender {
  const call = options.fetch ?? fetch;
  const attempt = async (message: SmsMessage): Promise<SmsResult | "retry"> => {
    let response: Response;
    try {
      response = await call(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userName: options.userName,
          apiKey: options.apiKey,
          numbers: message.to.replace(/^\+/, ""),
          userSender: options.sender,
          msg: message.text,
          msgEncoding: "UTF8",
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
    } catch (error) {
      const code = causeCode(error);
      if (code !== undefined && NEVER_LEFT.has(code)) {
        return "retry";
      }
      return {
        kind: "unknown",
        reason: (error as Error).name === "TimeoutError" ? "timeout" : "network",
      };
    }
    const body = (await response.json().catch(() => undefined)) as { code?: unknown } | undefined;
    const code = body?.code === undefined ? undefined : String(body.code);
    if (code !== undefined && SUCCESS.has(code)) {
      return { kind: "sent" };
    }
    if (code !== undefined) {
      // A definite answer from Msegat: the code did not go out (balance 1060, sender 1110, number 1120, IP M0037…).
      return { kind: "refused", reason: code };
    }
    return { kind: "unknown", reason: `http_${response.status}` };
  };
  return {
    name: "msegat",
    send: async (message) => {
      const first = await attempt(message);
      if (first !== "retry") {
        return first;
      }
      const second = await attempt(message);
      return second === "retry" ? { kind: "refused", reason: "unreachable" } : second;
    },
  };
}
