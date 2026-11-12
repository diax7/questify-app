"use client";

import { useState } from "react";
import { Muted } from "#src/ui/Feedback.tsx";

/**
 * A player's photo read straight from the private bucket through its 5-minute signed URL (T-301b): a plain `<img>`, not
 * `next/image`, which would fetch it through this origin. It sends no referrer, and the CSP's `img-src` names the
 * bucket's host (`MEDIA_HOST`). A link that ran out says so; the page's next read signs a new one.
 */
export function RemotePhoto({
  src,
  alt,
  expired,
}: Readonly<{ src: string; alt: string; expired: string }>) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Muted>{expired}</Muted>;
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
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
