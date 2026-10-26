import { citiesSchema, type City, type Language } from "@questify/shared";

/** The city list from `GET /v1/cities`; undefined when the answer is not the expected shape. */
export function readCities(body: unknown): City[] | undefined {
  const parsed = citiesSchema.safeParse(body);
  return parsed.success ? parsed.data.cities : undefined;
}

/** A city's name in the page's language, else the other one. */
export const cityName = (city: City, language: Language): string =>
  city.name[language] || city.name[language === "ar" ? "en" : "ar"];

/**
 * The cities to offer: the list as sent, plus the event's own city when it is not in it (a city removed from the
 * list later), so the form never silently shows another one.
 */
export function cityChoices(cities: readonly City[], current: string | null): readonly City[] {
  return current === null || cities.some((city) => city.id === current)
    ? cities
    : [{ id: current, name: { ar: current, en: current } }, ...cities];
}
