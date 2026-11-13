import type { Language } from "@questify/shared";
import { notFound, redirect } from "next/navigation";
import { splitHostConfig } from "#src/lib/config.ts";
import { isLanguage } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";

export type ConsolePage =
  | Readonly<{ kind: "admin"; language: Language }>
  | Readonly<{ kind: "unavailable"; language: Language }>;

/**
 * The checks every console page starts with: a known language, a session (else the sign-in page), and a Questify
 * platform admin (else "not found", as the API answers anyone else). Once the console has its own host (T-810d) its
 * pages are served only there, so anyone else signed in there is sent to the public host's home, where their dashboard
 * is (their session there is a dashboard one, which no console door takes). The API checks again on every call.
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
    const split = splitHostConfig();
    if (split !== undefined) {
      redirect(`${split.webOrigin}/${lang}`);
    }
    notFound();
  }
  return { kind: "admin", language: lang };
}
