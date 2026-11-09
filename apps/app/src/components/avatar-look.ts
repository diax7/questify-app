import { frameDesign, type Equipment } from "@questify/shared";
import type { ViewStyle } from "react-native";
import { avatarFace } from "#src/components/avatar-face.ts";

/** The brown of the circle's edge and of the corner diamond when a frame is worn. */
const FRAME_BROWN = "#8B5A2B";

type Frame = NonNullable<ReturnType<typeof frameDesign>>;

export type AvatarLook = Readonly<{
  /** The character shown: the worn one, or the avatar the player chose. */
  chosen: string;
  face: ReturnType<typeof avatarFace>;
  radius: number;
  border: number;
  /** Null when no frame is worn: the theme's own border colour then applies. */
  borderColor: string | null;
  /** The inner ring of a worn frame. */
  ring: ViewStyle | null;
  /** The diamond on the top edge of a frame that has a motif. */
  motif: ViewStyle | null;
}>;

function ringStyle(frame: Frame, radius: number, border: number): ViewStyle {
  return {
    position: "absolute",
    inset: 0,
    borderRadius: Math.max(0, radius - border),
    borderWidth: border,
    borderColor: frame.color,
    borderStyle: frame.double ? "dashed" : "solid",
  };
}

function motifStyle(size: number): ViewStyle {
  return {
    position: "absolute",
    top: 0,
    width: Math.max(2, size * 0.08),
    height: Math.max(2, size * 0.08),
    backgroundColor: FRAME_BROWN,
    transform: [{ rotate: "45deg" }],
  };
}

/** Everything an avatar's circle needs to know about the character and the frame the player wears. */
export function avatarLook(
  name: string,
  username: string,
  size: number,
  equipment: Equipment | undefined,
): AvatarLook {
  const chosen = equipment?.character?.visualKey ?? name;
  const frame = frameDesign(equipment?.frame?.visualKey);
  const { radius, border } = circleShape(frame, size);
  return {
    chosen,
    face: avatarFace(chosen, username),
    radius,
    border,
    ...frameParts(frame, radius, border, size),
  };
}

/** A square-ish frame rounds the circle less, and any frame thickens the edge. */
function circleShape(
  frame: ReturnType<typeof frameDesign>,
  size: number,
): Readonly<{ radius: number; border: number }> {
  return {
    radius: frame?.rounded === false ? size * 0.25 : size / 2,
    border: frame === null ? 1 : Math.max(1, size * 0.06),
  };
}

/** The edge colour, ring and diamond a worn frame adds; none when no frame is worn. */
function frameParts(
  frame: ReturnType<typeof frameDesign>,
  radius: number,
  border: number,
  size: number,
): Pick<AvatarLook, "borderColor" | "ring" | "motif"> {
  if (frame === null) {
    return { borderColor: null, ring: null, motif: null };
  }
  return {
    borderColor: FRAME_BROWN,
    ring: ringStyle(frame, radius, border),
    motif: frame.motif ? motifStyle(size) : null,
  };
}
