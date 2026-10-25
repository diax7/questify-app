import { equipmentSchema, lockerSchema, type ProfilePatch } from "@questify/shared";
import type { Session } from "#src/api/session.ts";
export { lockerSchema, publicProfileSchema } from "@questify/shared";
export type { LockerEntry, PublicProfile } from "@questify/shared";
export const equipmentOf = (value: unknown) => {
  const parsed = equipmentSchema.safeParse(value);
  return parsed.success ? parsed.data : { character: null, frame: null, title: null };
};
export async function lockerPage(session: Session, cursor?: string) {
  const result = await session.request({
    method: "GET",
    path: `/v1/me/locker${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
  });
  const parsed = result.kind === "ok" ? lockerSchema.safeParse(result.body) : null;
  return parsed?.success === true ? parsed.data : null;
}
export const saveProfile = (session: Session, patch: ProfilePatch) =>
  session.request({ method: "PATCH", path: "/v1/me", body: patch });
export const seeItems = async (session: Session, itemIds: string[]) =>
  (await session.request({ method: "POST", path: "/v1/me/locker/seen", body: { itemIds } }))
    .kind === "ok";
