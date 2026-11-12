import { useEffect, useState, type ReactNode } from "react";
import { Image, type ImageResizeMode, type ImageStyle, type StyleProp } from "react-native";
import { api } from "#src/api/app-session.ts";
import { createImageUrls } from "#src/event/organizer-images.ts";

/** The app's one store of signed image URLs, read through the player's session. */
const urls = createImageUrls((request) => api.session.request(request));

/**
 * An organizer's image (ADR-829): a logo, a banner, a map, a slide or card picture, game art or a vote option's icon,
 * read through the event's image door. Until it loads, and whenever it cannot (no image id, no bucket, a refusal, no
 * network, a broken file), it draws `fallback`, Questify's own art, so an event without images looks as before. `label`
 * is the holder's own words (a slide's title, an option's text), so a screen reader says what the picture is.
 */
export function OrganizerImage({
  eventId,
  imageId,
  label,
  style,
  resizeMode = "cover",
  fallback = null,
}: Readonly<{
  eventId: string | null | undefined;
  imageId: string | null | undefined;
  label: string;
  style: StyleProp<ImageStyle>;
  resizeMode?: ImageResizeMode;
  fallback?: ReactNode;
}>) {
  const ready =
    eventId === null || eventId === undefined || imageId === null || imageId === undefined
      ? undefined
      : urls.known(eventId, imageId);
  const [url, setUrl] = useState<string | null>(ready?.url ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    setBroken(false);
    if (eventId === null || eventId === undefined || imageId === null || imageId === undefined) {
      setUrl(null);
      return;
    }
    void urls.read(eventId, imageId).then((answer) => {
      if (live) setUrl(answer?.url ?? null);
    });
    return () => {
      live = false;
    };
  }, [eventId, imageId]);
  if (url === null || broken) return <>{fallback}</>;
  return (
    <Image
      source={{ uri: url }}
      style={style}
      resizeMode={resizeMode}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      onError={() => setBroken(true)}
    />
  );
}
