import { describe, expect, it, vi } from "vitest";
import { EMPTY_EQUIPMENT, MESSAGES, NO_OVERRIDES, createTranslator } from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import {
  equipmentOf,
  lockerPage,
  publicProfileSchema,
  saveProfile,
  seeItems,
} from "#src/questify/profile-api.ts";
import { frameDesign } from "@questify/shared";
import { levelUpMessage, levelUpOf } from "#src/questify/level.ts";

const title = { ar: "مستكشف", en: "Explorer" };
const item = {
  id: "level-2",
  kind: "frame" as const,
  name: { ar: "إطار الدرب", en: "Trail frame" },
  visualKey: "frame-01",
};
const session = (body: unknown, kind = "ok") =>
  ({ request: vi.fn().mockResolvedValue({ kind, body }) }) as unknown as Session;
describe("profile client contracts", () => {
  it("strips private fields from public DTOs and tolerates unknown shipped visuals", () => {
    const parsed = publicProfileSchema.parse({
      username: "sara",
      character: { starter: "falcon" },
      frame: item,
      title: null,
      level: { number: 2, title },
      identifiers: { email: "private" },
      xp: 100,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "character",
      "frame",
      "level",
      "title",
      "username",
    ]);
    expect(
      equipmentOf({ character: null, frame: { ...item, visualKey: "future-frame" }, title: null })
        .frame?.visualKey,
    ).toBe("future-frame");
    expect(equipmentOf({ frame: 123 })).toEqual(EMPTY_EQUIPMENT);
  });
  it("uses a finite fourteen-frame vocabulary and safely ignores unknown keys", () => {
    const designs = Array.from({ length: 14 }, (_, i) =>
      frameDesign(`frame-${String(i + 1).padStart(2, "0")}`),
    );
    expect(designs.every(Boolean)).toBe(true);
    expect(new Set(designs.map((x) => JSON.stringify(x))).size).toBe(14);
    for (const key of [null, undefined, "frame-00", "frame-15", "toString"])
      expect(frameDesign(key)).toBeNull();
  });
  it("never presents an unvalidated locker or acknowledges a failed request", async () => {
    expect(await lockerPage(session({ items: [{ item }], nextCursor: null }))).toBeNull();
    expect(await lockerPage(session(null, "network"))).toBeNull();
    expect(await seeItems(session(null, "network"), [item.id])).toBe(false);
    expect(await seeItems(session(null), [item.id])).toBe(true);
  });
  it("preserves clear/omitted slots and server refusals, without claiming a failed save", async () => {
    const s = session(null, "error");
    const patch = { frameId: null, titleId: "level-3" };
    expect((await saveProfile(s, patch)).kind).toBe("error");
    expect(s.request).toHaveBeenCalledWith({ method: "PATCH", path: "/v1/me", body: patch });
    const paging = session({ items: [], nextCursor: null });
    await lockerPage(paging, "a+b/?");
    expect(paging.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/me/locker?cursor=a%2Bb%2F%3F",
    });
  });
  it("names every earned item in a distinct localized sentence", () => {
    const value = levelUpOf({
      level: 3,
      title,
      items: [
        item,
        {
          ...item,
          id: "level-3",
          kind: "title",
          name: { ar: "رفيق الدرب", en: "Trail companion" },
          visualKey: null,
        },
      ],
    });
    expect(value?.items).toHaveLength(2);
    const translator = createTranslator(MESSAGES, NO_OVERRIDES);
    for (const language of ["ar", "en"] as const) {
      const t = (key: keyof typeof MESSAGES, params?: Readonly<Record<string, string | number>>) =>
        translator(key, language, params);
      const line = levelUpMessage(t, language, value!);
      expect(line).toContain(
        `${t("level.upLine", { level: 3, title: title[language] })}. ${t("locker.rewardLine", { items: language === "ar" ? "إطار الدرب، رفيق الدرب" : "Trail frame, Trail companion" })}`,
      );
    }
  });
});
