"use client";

import {
  IMAGE_UPLOAD_BYTES,
  IMAGE_UPLOAD_TYPES,
  imageUploadPath,
  storedImageSchema,
  teamImagePath,
  type ImagePurpose,
  type Language,
} from "@questify/shared";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";

/** The event whose images a page edits, and whether this server stores images at all (ADR-829). */
type ImageScopeValue = Readonly<{ organizerId: string; eventId: string; photos: boolean }>;

const ImageScopeContext = createContext<ImageScopeValue | null>(null);

/** Set once by the event's frame (the event layout), so every image field on its pages knows its event. */
export function ImageScope({
  children,
  ...value
}: ImageScopeValue & Readonly<{ children: ReactNode }>) {
  return <ImageScopeContext.Provider value={value}>{children}</ImageScopeContext.Provider>;
}

/** Whether the page may offer image fields: inside an event's frame, on a server with a bucket. */
export function useImagesOn(): boolean {
  return useContext(ImageScopeContext)?.photos === true;
}

/** The team's read path of one of this event's images, or null outside an event or on a server with no bucket. */
export function useTeamImageSrc(imageId: string | null | undefined): string | null {
  const scope = useContext(ImageScopeContext);
  return scope === null || !scope.photos || imageId === null || imageId === undefined
    ? null
    : teamImagePath(scope.organizerId, scope.eventId, imageId);
}

const UPLOAD_TIMEOUT_MS = 95_000;

/** Sends one file to the image door with a fresh Idempotency-Key: the new image's id, or the words of the refusal. */
async function send(
  scope: ImageScopeValue,
  purpose: ImagePurpose,
  file: File,
  problem: (body: unknown) => string,
): Promise<Readonly<{ id: string } | { error: string }>> {
  try {
    const response = await fetch(imageUploadPath(scope.organizerId, scope.eventId, purpose), {
      method: "POST",
      headers: { "content-type": file.type, "idempotency-key": crypto.randomUUID() },
      body: file,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const stored = storedImageSchema.safeParse(body);
    return response.ok && stored.success ? { id: stored.data.imageId } : { error: problem(body) };
  } catch {
    return { error: problem(undefined) };
  }
}

/**
 * One organizer image of an event (ADR-829): a preview through the team's read door, a file picker (JPEG, PNG or WebP,
 * at most 8 MB, checked here and again by the server), Replace and Remove. It holds only the image's id; the holder's own
 * save names it, and a refused id comes back as that save's error. Shown only inside an event on a server with a bucket.
 */
export function ImageField({
  language,
  purpose,
  label,
  value,
  onChange,
  disabled = false,
}: Readonly<{
  language: Language;
  purpose: ImagePurpose;
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}>) {
  const t = useTranslator(language);
  const scope = useContext(ImageScopeContext);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (scope === null || !scope.photos) return null;

  const pick = async (file: File | undefined) => {
    if (file === undefined) return;
    setProblem(null);
    if (!(IMAGE_UPLOAD_TYPES as readonly string[]).includes(file.type)) {
      setProblem(t("image.wrongType"));
      return;
    }
    if (file.size > IMAGE_UPLOAD_BYTES) {
      setProblem(t("image.tooLarge"));
      return;
    }
    setBusy(true);
    const sent = await send(scope, purpose, file, (body) =>
      body === undefined ? t("image.failed") : describeProblem(body, language, t).text,
    );
    setBusy(false);
    if ("id" in sent) onChange(sent.id);
    else setProblem(sent.error);
  };

  return (
    <Stack>
      <span>{label}</span>
      {value === null ? (
        <Muted>{t("image.none")}</Muted>
      ) : (
        <img
          src={teamImagePath(scope.organizerId, scope.eventId, value)}
          alt={t("image.preview", { label })}
          referrerPolicy="no-referrer"
          decoding="async"
          style={{
            display: "block",
            inlineSize: "100%",
            maxInlineSize: purpose === "logo" || purpose === "icon" ? "8rem" : "20rem",
            blockSize: "auto",
            borderRadius: "var(--radius-md)",
          }}
        />
      )}
      <input
        ref={input}
        aria-label={label}
        type="file"
        accept={IMAGE_UPLOAD_TYPES.join(",")}
        hidden
        disabled={disabled || busy}
        onChange={(event) => {
          void pick(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <Toolbar>
        <Button
          size="sm"
          disabled={disabled || busy}
          aria-busy={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? t("image.uploading") : t(value === null ? "image.choose" : "image.replace")}
        </Button>
        {value === null ? null : (
          <Button
            size="sm"
            variant="quiet"
            disabled={disabled || busy}
            onClick={() => onChange(null)}
          >
            {t("image.remove")}
          </Button>
        )}
      </Toolbar>
      {problem === null ? null : (
        <Notice role="alert" tone="danger">
          {problem}
        </Notice>
      )}
    </Stack>
  );
}
