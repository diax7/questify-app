const VERSION = /^[0-9]+(\.[0-9]+){1,2}$/;

function parts(version: string): [number, number, number] {
  if (!VERSION.test(version)) {
    throw new RangeError(`"${version}" is not an app version such as 1.2.3.`);
  }
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return [major, minor, patch];
}

/** Returns -1, 0 or 1 like a sort comparator. Two-part versions count as x.y.0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) {
      return l > r ? 1 : -1;
    }
  }
  return 0;
}

/** True when the app is older than the minimum the server supports (the API then answers 426). */
export function isBelowMinimum(appVersion: string, minimum: string): boolean {
  return compareVersions(appVersion, minimum) < 0;
}
