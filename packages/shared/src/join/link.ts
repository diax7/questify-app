/** The hosts whose `/{ar|en}/e/{code}` links are Questify join links (the QR and the invite link carry the same one). */
export const JOIN_LINK_HOSTS: readonly string[] = ["questify.sa", "www.questify.sa"];

const CODE = /^[A-Za-z0-9]{4,12}$/;
const PATH = /^\/(?:ar|en)\/e\/([A-Za-z0-9]{4,12})\/?$/;

/**
 * Reads an event's join code from what the scanner read or the person typed (FR-101, FR-102, FR-103): a join link on a
 * Questify host, or a bare code. Anything else is not a Questify join code, and the app says so.
 */
export function parseJoinLink(text: string): string | null {
  const trimmed = text.trim();
  if (CODE.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !JOIN_LINK_HOSTS.includes(url.hostname)) {
    return null;
  }
  return PATH.exec(url.pathname)?.[1]?.toUpperCase() ?? null;
}

/** The join link for a code, in the page's language (T-112 serves it; the join QR encodes it). */
export function joinLink(code: string, language: "ar" | "en"): string {
  return `https://${JOIN_LINK_HOSTS[0]}/${language}/e/${code}`;
}
