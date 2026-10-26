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
      achievements: [{ id: "events-attended", tier: "bronze" }],
      passport: [],
      identifiers: { email: "private" },
      xp: 100,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "achievements",
      "character",
      "frame",
      "level",
      "passport",
      "title",
      "username",
    ]);
    expect(
      equipmentOf({ character: null, frame: { ...item, visualKey: "future-frame" }, title: null })
        .frame?.visualKey,
    ).toBe("future-frame");
    expect(equipmentOf({ frame: 123 })).toEqual(EMPTY_EQUIPMENT);
  });
  it("uses a finite twenty-frame vocabulary and safely ignores unknown keys", () => {
    const designs = Array.from({ length: 20 }, (_, i) =>
      frameDesign(`frame-${String(i + 1).padStart(2, "0")}`),
    );
    expect(designs.every(Boolean)).toBe(true);
    expect(new Set(designs.map((x) => JSON.stringify(x))).size).toBe(20);
    for (const key of [null, undefined, "frame-00", "frame-21", "toString"])
      expect(frameDesign(key)).toBeNull();
  });
  it("never presents an unvalidated locker or acknowledges a failed request", async () => {
    expect(await lockerPage(session({ items: [{ item }], nextCursor: null }))).toBeNull();
    expect(await lockerPage(session(null, "network"))).toBeNull();
    expect(await seeItems(session(null, "network"), [item.id])).toBe(false);
    expect(await seeItems(session(null), [item.id])).toBe(true);
  });
  it("parses own event provenance alongside level items and refuses malformed source payloads", async () => {
    const source = {
      kind: "event",
      event: {
        id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        name: { ar: "فعالية خاصة", en: "Private event" },
      },
    };
    const entry = {
      item: { ...item, id: "souvenir-a" },
      earnedAt: "2026-10-25T10:20:30.123456Z",
      source,
      seen: false,
    };
    const page = await lockerPage(
      session({
        items: [entry, { ...entry, item, source: { kind: "level", level: 2 } }],
        nextCursor: null,
      }),
    );
    expect(page?.items.map((row) => row.source.kind)).toEqual(["event", "level"]);
    expect(page?.items[0]?.earnedAt).toBe(entry.earnedAt);
    for (const bad of [
      { kind: "event" },
      { kind: "event", event: { ...source.event, id: "bad" } },
      { kind: "unknown" },
    ]) {
      expect(
        await lockerPage(session({ items: [{ ...entry, source: bad }], nextCursor: null })),
      ).toBeNull();
    }
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
