import type { Language } from "@questify/shared";
import { notFound, redirect } from "next/navigation";
import { isLanguage } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import type { Membership } from "#src/lib/staff-api.ts";

export type OrganizerPage =
  | Readonly<{ kind: "member"; language: Language; membership: Membership }>
  | Readonly<{ kind: "unavailable"; language: Language }>;

/**
 * The checks every organizer page starts with: a known language, a session (else the sign-in page), and a membership
 * of this organizer (else "not found", as the API answers a non-member). `unavailable` when the API could not say.
 */
export async function organizerPage(lang: string, organizerId: string): Promise<OrganizerPage> {
  if (!isLanguage(lang)) {
    notFound();
  }
  const staff = await currentStaff();
  if (staff.kind === "signed_out") {
    redirect(`/${lang}/sign-in${staff.ended ? "?ended=1" : ""}`);
  }
  if (staff.kind === "unavailable") {
    return { kind: "unavailable", language: lang };
  }
  const membership = staff.me.memberships.find((item) => item.organizerId === organizerId);
  if (membership === undefined) {
    notFound();
  }
  return { kind: "member", language: lang, membership };
}
