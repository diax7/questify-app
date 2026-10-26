import { describe, expect, it } from "vitest";
import { cityChoices, cityName, readCities } from "#src/lib/cities.ts";

const riyadh = { id: "sa-riyadh", name: { ar: "الرياض", en: "Riyadh" } };
const jeddah = { id: "sa-jeddah", name: { ar: "جدة", en: "Jeddah" } };

describe("readCities", () => {
  it("reads the list the API sends", () => {
    expect(readCities({ cities: [riyadh, jeddah] })).toEqual([riyadh, jeddah]);
  });

  it("is undefined for anything else, so a broken answer is not an empty list", () => {
    expect(readCities(undefined)).toBeUndefined();
    expect(readCities({})).toBeUndefined();
    expect(readCities({ cities: [{ id: "sa-riyadh" }] })).toBeUndefined();
    expect(readCities([riyadh])).toBeUndefined();
  });
});

describe("cityName", () => {
  it("uses the page's language and falls back to the other one", () => {
    expect(cityName(riyadh, "ar")).toBe("الرياض");
    expect(cityName(riyadh, "en")).toBe("Riyadh");
    expect(cityName({ id: "sa-x", name: { ar: "", en: "X" } }, "ar")).toBe("X");
  });
});

describe("cityChoices", () => {
  it("offers the list as it is when the event has no city or one from the list", () => {
    expect(cityChoices([riyadh, jeddah], null)).toEqual([riyadh, jeddah]);
    expect(cityChoices([riyadh, jeddah], "sa-jeddah")).toEqual([riyadh, jeddah]);
  });

  it("puts the event's own city first when the list no longer has it", () => {
    expect(cityChoices([riyadh], "sa-old")[0]).toEqual({
      id: "sa-old",
      name: { ar: "sa-old", en: "sa-old" },
    });
  });
});
