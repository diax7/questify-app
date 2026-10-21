import type { Me } from "#src/auth/player.tsx";

/** Remembered on this phone once the card has shown; cleared at sign-out with the other player keys. */
export const ADD_EMAIL_SHOWN_KEY = "questify.addEmailShown";

/** FR-1817: only a phone-only player is invited, once per phone, to add an email for the email fallback. */
export function offersAddEmail(me: Me | undefined, alreadyShown: boolean): boolean {
  return (
    !alreadyShown &&
    me !== undefined &&
    me.identifiers.phone !== null &&
    me.identifiers.email === null
  );
}
