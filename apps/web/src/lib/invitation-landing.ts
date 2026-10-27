import {
  INVITATION_TOKEN,
  invitationOpenSchema,
  type InvitationOpen,
  type Language,
} from "@questify/shared";
import type { PostResult } from "#src/lib/post-json.ts";

/** The recipient's token in a page's fragment (`#` and the 22 characters), or undefined when there is none. */
export function tokenFromHash(hash: string): string | undefined {
  const token = hash.startsWith("#") ? hash.slice(1) : hash;
  return INVITATION_TOKEN.test(token) ? token : undefined;
}

export type Landing =
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "ended" }>
  | Readonly<{ kind: "throttled" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "found"; event: InvitationOpen["event"] }>;

/**
 * What the open door's answer means for the page. Only the public event card is read: a 404 is a link that has ended
 * (unknown, removed after 90 days, or its event is over), a 400 a link that is not ours, a 429 too many tries.
 */
export function landingOf(result: PostResult): Landing {
  if (result.ok) {
    const parsed = invitationOpenSchema.safeParse(result.body);
    return parsed.success ? { kind: "found", event: parsed.data.event } : { kind: "unavailable" };
  }
  switch (result.status) {
    case 404:
      return { kind: "ended" };
    case 400:
      return { kind: "missing" };
    case 429:
      return { kind: "throttled" };
    default:
      return { kind: "unavailable" };
  }
}

/** The plain join link of the event (`/{lang}/e/{code}`), which opens the app or the stores. */
export const joinPath = (language: string, joinCode: string): string =>
  `/${language}/e/${encodeURIComponent(joinCode)}`;

/** A name or venue in the page's language, else the other one, else empty (an event may be written in one language). */
export function textIn(
  text: Readonly<{ ar: string | null; en: string | null }>,
  language: Language,
): string {
  return (language === "ar" ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? "";
}
