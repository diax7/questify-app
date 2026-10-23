import { useSyncExternalStore } from "react";

let open = 0;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

/** Counts one sheet as open until the returned function runs (Sheet calls it while visible). */
export function sheetOpened(): () => void {
  open += 1;
  notify();
  let closed = false;
  return () => {
    if (!closed) {
      closed = true;
      open -= 1;
      notify();
    }
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** How many sheets are open now, so the live poll card waits for a calm screen (T-306). */
export function useOpenSheets(): number {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => open,
  );
}
