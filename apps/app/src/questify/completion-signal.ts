type Listener = () => void;

const listeners = new Set<Listener>();

/** The sync provider listens here so that a completion from any screen starts its debounce. */
export function onCompletion(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A quest was completed for the first time (called by the one parser every completion answer passes through). */
export function noteCompletion(): void {
  for (const listener of listeners) listener();
}
