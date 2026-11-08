import { useRef } from "react";
import { requestJson, type PostResult, type RequestOptions } from "#src/lib/post-json.ts";

export type RequestKey = ReturnType<typeof createRequestKey>;

/**
 * One Idempotency-Key per distinct request: a retry of the same one after a dropped answer replays the first answer
 * (nothing is made twice), a changed request takes a new key, and a finished one forgets its key.
 */
export function createRequestKey() {
  let last: { signature: string; key: string } | null = null;
  return {
    keyFor: (signature: string): string => {
      if (last?.signature !== signature) {
        last = { signature, key: crypto.randomUUID() };
      }
      return last.key;
    },
    forget: () => {
      last = null;
    },
  };
}

export function useRequestKey(): RequestKey {
  const keys = useRef<RequestKey | null>(null);
  keys.current ??= createRequestKey();
  return keys.current;
}

/**
 * The one refusal that says "not yet" for this very request: the same key is still running. It is never stored under the
 * key; every other 4xx, `change_set_busy` included, is stored and would replay, so it ends the request.
 */
const NOT_FINAL_CODES: ReadonlySet<string> = new Set(["request_in_progress"]);

/**
 * Whether an answer ends the request, so the next call is a new one with a new key: a 2xx, or a 4xx other than the
 * same request still running. A dropped connection, a timeout and a 5xx are not final: the
 * first try may have been applied, and the same key brings back its stored answer.
 */
export function isFinalAnswer(result: PostResult): boolean {
  if (result.ok) {
    return true;
  }
  if (result.status === undefined || result.status === 0 || result.status >= 500) {
    return false;
  }
  return !NOT_FINAL_CODES.has(codeOf(result.body));
}

/** The API's `code` of an error answer, or an empty string. */
function codeOf(body: unknown): string {
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : "";
  return typeof code === "string" ? code : "";
}

/** One call with the key of its signature; the key is forgotten once the answer is final. */
export async function keyedRequest(
  keys: RequestKey,
  signature: string,
  call: Readonly<{
    method: "POST" | "PUT";
    path: string;
    payload: unknown;
    options?: RequestOptions;
  }>,
): Promise<PostResult> {
  const result = await requestJson(
    call.method,
    call.path,
    call.payload,
    { "idempotency-key": keys.keyFor(signature) },
    call.options,
  );
  if (isFinalAnswer(result)) {
    keys.forget();
  }
  return result;
}
