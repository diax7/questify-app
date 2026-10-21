import { AVATARS, type Avatar } from "@questify/shared";

/**
 * Which face an avatar shows: one of the six this app ships (FR-117), or the username's first letter for one it does
 * not know, so a seventh avatar added on the server never breaks a row (F-282). Never an object key lookup alone, which
 * would let a name like "toString" through.
 */
export function avatarFace(
  name: string,
  username: string,
): Readonly<{ kind: "image"; avatar: Avatar }> | Readonly<{ kind: "letter"; letter: string }> {
  const known = AVATARS.find((avatar) => avatar === name);
  return known === undefined
    ? { kind: "letter", letter: username.slice(0, 1).toUpperCase() }
    : { kind: "image", avatar: known };
}
