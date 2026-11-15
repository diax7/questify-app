"use client";

import { useState } from "react";
import { linkToShow } from "#src/lib/kept-link.ts";
import { Muted } from "#src/ui/Feedback.tsx";

type Props = Readonly<{
  src: string;
  alt: string;
  expired: string;
  /**
   * The photo's own id (a media or submission id), when the list is read again while it shows: the picture keeps the
   * link it loaded with, so a newly signed link does not load it again (T-814, plan review 86 MINOR 7).
   */
  photoId?: string | undefined;
}>;

/** Keyed by the photo's id when given, else by `src`, so a newly signed link after an expired one is tried again. */
export function RemotePhoto(props: Props) {
  return <SignedImage key={props.photoId ?? props.src} {...props} />;
}

/**
 * A player's photo read from the media route through its 5-minute signed link (T-301b, T-814): a plain `<img>`, not
 * `next/image`, which would fetch it through this origin. It sends no referrer, and the CSP's `img-src` names the API's
 * host (`MEDIA_HOST`). It keeps the link it first loaded with; a link that failed gives way to the newest one, and when
 * that fails too it says so (the page's next read signs a new one).
 */
function SignedImage({ src, alt, expired }: Props) {
  const [shown, setShown] = useState(src);
  const [failed, setFailed] = useState<string | null>(null);
  const current = linkToShow(shown, failed, src);
  if (current === null) return <Muted>{expired}</Muted>;
  return (
    <img
      src={current}
      alt={alt}
      referrerPolicy="no-referrer"
      loading="eager"
      decoding="async"
      onError={() => {
        setFailed(current);
        setShown(current);
      }}
      style={{
        display: "block",
        inlineSize: "100%",
        maxInlineSize: "28rem",
        blockSize: "auto",
        borderRadius: "var(--radius-md)",
      }}
    />
  );
}
