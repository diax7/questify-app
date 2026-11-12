import type { GameImages } from "@questify/shared";
import { createContext, useContext, type ReactNode } from "react";
import type { ImageResizeMode, ImageStyle, StyleProp } from "react-native";
import { OrganizerImage } from "#src/event/OrganizerImage.tsx";

/** The organizer's art for the round being played (T-305b) and the event it is read through; none by default. */
type Art = Readonly<{ eventId: string | null; images: GameImages }>;

const GameArtContext = createContext<Art>({ eventId: null, images: {} });

export function GameArtScope({
  eventId,
  images,
  children,
}: Readonly<{ eventId: string | null; images: GameImages | undefined; children: ReactNode }>) {
  return (
    <GameArtContext.Provider value={{ eventId, images: images ?? {} }}>
      {children}
    </GameArtContext.Provider>
  );
}

export const useGameArt = (): Art => useContext(GameArtContext);

/**
 * One picture of a game: the organizer's (`imageId`) when there is one, else the game's own art (`fallback`), which
 * also stands in while the organizer's loads or when it cannot be drawn. The board's rules never depend on which.
 */
export function GamePicture({
  imageId,
  label,
  style,
  resizeMode = "contain",
  fallback,
}: Readonly<{
  imageId: string | undefined;
  label: string;
  style: StyleProp<ImageStyle>;
  resizeMode?: ImageResizeMode;
  fallback: ReactNode;
}>) {
  const { eventId } = useGameArt();
  if (imageId === undefined || eventId === null) return <>{fallback}</>;
  return (
    <OrganizerImage
      eventId={eventId}
      imageId={imageId}
      label={label}
      style={style}
      resizeMode={resizeMode}
      fallback={fallback}
    />
  );
}
