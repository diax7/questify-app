import { useRef } from "react";

/**
 * One Idempotency-Key per distinct request: a retry of the same one after a dropped answer replays the first answer
 * (nothing is made twice), a changed request takes a new key, and a finished one forgets its key.
 */
export function useRequestKey() {
  const last = useRef<{ signature: string; key: string } | null>(null);
  return {
    keyFor: (signature: string): string => {
      if (last.current?.signature !== signature) {
        last.current = { signature, key: crypto.randomUUID() };
      }
      return last.current.key;
    },
    forget: () => {
      last.current = null;
    },
  };
}
