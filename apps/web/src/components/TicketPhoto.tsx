"use client";

import type { Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { RemotePhoto } from "#src/ui/RemotePhoto.tsx";

/** A help request's photo (T-301b, FR-337) through its signed URL; nothing when it has none. */
export function TicketPhoto({
  language,
  url,
}: Readonly<{ language: Language; url: string | null | undefined }>) {
  const t = translatorFor(language);
  if (typeof url !== "string") return null;
  return <RemotePhoto src={url} alt={t("photo.alt")} expired={t("photo.expired")} />;
}
