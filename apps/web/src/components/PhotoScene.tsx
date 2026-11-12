"use client";

import { useEffect, useState } from "react";
import { keptPhotos, type WallPhoto } from "#src/lib/big-screen.ts";
import type { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/device.module.css";

type Translate = ReturnType<typeof translatorFor>;

/**
 * The photo wall scene (T-504b, FR-635): the picked photos in the team's order, read straight from the private bucket
 * through their short signed URLs (a plain `<img>` with no referrer; the CSP's `img-src` names the bucket). No name is
 * drawn (plan section 7, M5). A photo keeps the URL it first loaded with while it stays in the answer, so it never
 * flickers on a newly signed link, and a photo the latest answer left out (withdrawn, rejected, held) goes at once.
 */
export function PhotoScene({
  photos,
  t,
}: Readonly<{ photos: readonly WallPhoto[]; t: Translate }>) {
  const [shown, setShown] = useState<readonly WallPhoto[]>(photos);
  useEffect(() => {
    setShown((before) => keptPhotos(before, photos));
  }, [photos]);
  return (
    <ul className={styles.photoWall}>
      {shown.map((photo, index) => (
        <li key={photo.mediaId} className={styles.photoTile}>
          <img
            src={photo.url}
            alt={t("screen.photo.alt", { number: String(index + 1) })}
            referrerPolicy="no-referrer"
            decoding="async"
            className={styles.photoImage}
          />
        </li>
      ))}
    </ul>
  );
}
