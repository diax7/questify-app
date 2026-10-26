import { describe, expect, it } from "vitest";
import { souvenirBodySchema } from "./souvenirs";

const body = {
  kind: "frame",
  name: { ar: "إطار الرحلة", en: "Journey frame" },
  visualKey: "frame-01",
  audience: "joined",
};
describe("souvenir configuration", () => {
  it("accepts every shipped frame and all three item kinds without accepting arbitrary art", () => {
    for (let index = 1; index <= 14; index += 1)
      expect(
        souvenirBodySchema.safeParse({
          ...body,
          visualKey: `frame-${String(index).padStart(2, "0")}`,
        }).success,
      ).toBe(true);
    expect(souvenirBodySchema.safeParse({ ...body, kind: "title", visualKey: null }).success).toBe(
      true,
    );
    expect(
      souvenirBodySchema.safeParse({ ...body, kind: "character", visualKey: "chest" }).success,
    ).toBe(true);
    for (const visualKey of [null, "frame-00", "frame-15", "chest", "https://remote/art"])
      expect(souvenirBodySchema.safeParse({ ...body, visualKey }).success).toBe(false);
  });
  it("rejects forged fields and invalid audience/target combinations", () => {
    for (const patch of [
      { playerId: "forged" },
      { source: "level" },
      { kind: "other" },
      { audience: "rank" },
      { audience: "rank", rankFrom: 3, rankTo: 1 },
      { audience: "rank", rankFrom: 1, rankTo: 101 },
      { audience: "category" },
      { categoryId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" },
      { name: { ar: "", en: "Name" } },
    ]) {
      expect(souvenirBodySchema.safeParse({ ...body, ...patch }).success).toBe(false);
    }
  });
  it("refuses control and direction characters in public names and keeps ordinary Arabic", () => {
    for (const ar of ["إطار\u202Eالرحلة", "إطار\u0000", "إطار\u0007الرحلة", "إطار\u2066الرحلة"])
      expect(souvenirBodySchema.safeParse({ ...body, name: { ar, en: "Frame" } }).success).toBe(
        false,
      );
    expect(
      souvenirBodySchema.safeParse({ ...body, name: { ar: "Frame", en: "Frame\u2029two" } })
        .success,
    ).toBe(false);
    expect(
      souvenirBodySchema.safeParse({
        ...body,
        name: { ar: "بطل هاكاثون 2026", en: "Hackathon hero" },
      }).success,
    ).toBe(true);
  });
});
