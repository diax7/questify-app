import { parseJoinLink } from "@questify/shared";
import { inviteTokenOf } from "#src/operator/station.ts";

/** The app link `questify://operator-invite/{token}` as Expo Router hands it over: its path alone. */
const INVITE_PATH = /^\/?operator-invite\/([A-Za-z0-9_-]{50})$/;
const JOIN_PATH = /^\/(?:ar|en)\/e\/([A-Za-z0-9]{4,12})\/?(?:[?#].*)?$/;

/**
 * Where an incoming link opens the app (FR-103). The system hands it over as a full URL or as its path alone,
 * depending on the platform and on a cold start; only the join link's path `/{ar|en}/e/{CODE}` opens a join card. A
 * bare code is not read from a path: a short segment of some other link must never become an event code.
 */
export function routeForIncoming(incoming: string): string {
  // An operator invite (T-204): the web page's app link, or the dashboard's `/op#` address on a universal link.
  const invite = inviteTokenOf(incoming) ?? INVITE_PATH.exec(incoming)?.[1];
  if (invite !== undefined && invite !== null) {
    return `/operator-invite/${invite}`;
  }
  const fromUrl = incoming.startsWith("https://")
    ? parseJoinLink(incoming.replace(/[?#].*$/, ""))
    : null;
  const fromPath = fromUrl === null ? JOIN_PATH.exec(incoming)?.[1]?.toUpperCase() : undefined;
  const code = fromUrl ?? fromPath;
  return code === undefined || code === null ? "/" : `/join/${code}?via=link`;
}
