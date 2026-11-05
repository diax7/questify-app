import type { Language } from "@questify/shared";
import { notFound, redirect } from "next/navigation";
import { webConfig } from "#src/lib/config.ts";
import { isLanguage } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";

export type ConsolePage =
  | Readonly<{ kind: "admin"; language: Language }>
  | Readonly<{ kind: "unavailable"; language: Language }>;

/**
 * The checks every console page starts with: a known language, a session (else the sign-in page), and a Questify
 * platform admin. Console pages are served only on the console host (T-810d), so anyone else signed in there is sent to
 * the public host's home, where their dashboard is (their session here is a dashboard one, which no console door
 * takes). The API checks again on every call.
 */
export async function consolePage(lang: string): Promise<ConsolePage> {
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
  if (!staff.me.isAdmin) {
    redirect(`${webConfig().dashboardOrigin}/${lang}`);
  }
  return { kind: "admin", language: lang };
}
