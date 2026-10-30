"use client";

import { useParams } from "next/navigation";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { PageSkeleton } from "#src/ui/Skeleton.tsx";

/**
 * The `loading.tsx` of a route group: a page-shaped skeleton in the page's language, shown inside the group's shell
 * while the next page is read. A loading file is given no params, so the language comes from the address.
 */
export function LoadingPage() {
  const { lang } = useParams<{ lang: string }>();
  return <PageSkeleton label={translatorFor(isLanguage(lang) ? lang : "en")("common.loading")} />;
}
