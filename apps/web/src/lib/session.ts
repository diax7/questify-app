import { cookies, headers } from "next/headers";
import { cache } from "react";
import { webConfig } from "#src/lib/config.ts";
import { SESSION_COOKIE, fetchMe, type MeResult } from "#src/lib/staff-api.ts";

/**
 * Who is signed in for this page request: `/me` must answer, a cookie alone proves nothing. Asked once per request, so
 * a layout and the page inside it share one answer.
 */
export const currentStaff = cache(async (): Promise<MeResult> => {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  return fetchMe({
    apiOrigin: webConfig().apiOrigin,
    sessionToken: jar.get(SESSION_COOKIE)?.value,
    forwardedFor: incoming.get("x-forwarded-for"),
  });
});
