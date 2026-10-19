/**
 * A small cache whose entries expire after `ttlMs`. Settings are read by every app at every launch, so
 * the database sees at most one read per entry per interval, and a change shows up everywhere within that interval.
 */
export type TtlCache<V> = Readonly<{
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  clear: () => void;
}>;

export function createTtlCache<V>(options: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}): TtlCache<V> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: V; expiresAt: number }>();
  return {
    get: (key) => {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        // Stryker disable next-line CallExpression: equivalent, a dead entry is never returned and is dropped when it ages out of the maximum
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set: (key, value) => {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + options.ttlMs });
      if (entries.size > options.maxEntries) {
        const [oldest] = entries.keys();
        // Stryker disable next-line ConditionalExpression: equivalent, the map holds more than the maximum here so it has a first key
        if (oldest !== undefined) {
          entries.delete(oldest);
        }
      }
    },
    clear: () => entries.clear(),
  };
}
