import type { Language } from "@questify/shared";

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A prize still waiting for its handover (FR-128), as `POST /v1/deletion/verify` lists it. */
export type PendingPrize = Readonly<{
  redemptionId: string;
  event: Bilingual;
  item: Bilingual;
  rankPrize: boolean;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const bilingual = (value: unknown): Bilingual => {
  const record = isRecord(value) ? value : {};
  const text = (key: string) => (typeof record[key] === "string" ? record[key] : null);
  return { ar: text("ar"), en: text("en") };
};

/** The waiting prizes an answer lists; anything malformed is left out rather than shown wrong. */
export function pendingOf(value: unknown): PendingPrize[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) =>
    typeof item["redemptionId"] === "string"
      ? [
          {
            redemptionId: item["redemptionId"],
            event: bilingual(item["event"]),
            item: bilingual(item["item"]),
            rankPrize: item["rankPrize"] === true,
          },
        ]
      : [],
  );
}

/** A name in the page's language, falling back to the other one. */
export function textIn(text: Bilingual, language: Language): string {
  return (language === "ar" ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? "";
}

/** The deletion token a verify answer carries, or undefined. */
export function deletionTokenOf(body: unknown): string | undefined {
  const token = isRecord(body) ? body["deletionToken"] : undefined;
  return typeof token === "string" ? token : undefined;
}
