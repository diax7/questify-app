import { routeForIncoming } from "#src/join/deep-link.ts";

/**
 * Where a link from outside the app opens it (FR-103): the join link `https://questify.sa/{ar|en}/e/{CODE}` opens that
 * event's join card; anything else opens Home. Expo Router calls this before it resolves a path. Push links (T-501)
 * will need to pass through here too.
 */
export function redirectSystemPath({ path }: Readonly<{ path: string; initial: boolean }>): string {
  return routeForIncoming(path);
}
