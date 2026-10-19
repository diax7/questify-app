import { isIP } from "node:net";

/** Trims, applies Unicode NFKC and lower-cases an email so equal addresses always compare equal. */
export function normalizeEmail(input: string): string {
  return input.normalize("NFKC").trim().toLowerCase();
}

/** The number of characters a person sees (Unicode code points), not UTF-16 units. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/** Applies NFKC so the same password typed on different keyboards hashes the same. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

const ZONE = /%.*$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

const groupsOf = (part: string): string[] => (part === "" ? [] : part.split(":"));

function expandIpv6(address: string): string[] {
  const [head = "", tail] = address.split("::");
  const headGroups = groupsOf(head);
  const tailGroups = tail === undefined ? [] : groupsOf(tail);
  const missing = 8 - headGroups.length - tailGroups.length;
  const all =
    tail === undefined
      ? headGroups
      : [...headGroups, ...Array.from({ length: missing }, () => "0"), ...tailGroups];
  return all.map((group) => group.toLowerCase().padStart(4, "0"));
}

/**
 * Reduces a client address to the unit that is throttled: an IPv4 address as is (an IPv4-mapped IPv6
 * address becomes plain IPv4), and an IPv6 address to its /64 prefix, because one customer holds a whole /64.
 *
 * @returns "unknown" when the text is not an IP address, so a bad value shares one bucket instead of escaping the limit.
 */
export function addressBucket(address: string): string {
  const mapped = IPV4_MAPPED.exec(address);
  const candidate = (mapped?.[1] ?? address).replace(ZONE, "");
  const version = isIP(candidate);
  if (version === 4) {
    return candidate;
  }
  if (version === 6) {
    return `${expandIpv6(candidate).slice(0, 4).join(":")}::/64`;
  }
  return "unknown";
}
