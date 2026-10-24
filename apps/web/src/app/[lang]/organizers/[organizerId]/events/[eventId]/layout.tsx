import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { TermsScope } from "#src/components/TermsScope.tsx";
import { webConfig } from "#src/lib/config.ts";
import { fetchEventTerms } from "#src/lib/event-terms.ts";
import { SESSION_COOKIE } from "#src/lib/staff-api.ts";

type Props = Readonly<{
  children: ReactNode;
  params: Promise<{ organizerId: string; eventId: string }>;
}>;

/**
 * Every page of one event shows the event's quest and category words (FR-942). The words are read once here, with the
 * organizer's session; saving them refreshes the layout (`router.refresh()` in the Event words form).
 */
export default async function EventLayout({ children, params }: Props) {
  const { organizerId, eventId } = await params;
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const terms = await fetchEventTerms({
    apiOrigin: webConfig().apiOrigin,
    organizerId,
    eventId,
    sessionToken: jar.get(SESSION_COOKIE)?.value,
    forwardedFor: incoming.get("x-forwarded-for"),
  });
  return <TermsScope terms={terms}>{children}</TermsScope>;
}
