import { toLocalInput } from "@questify/shared";

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

export const REWARD_KINDS = ["item", "experience", "digital"] as const;
export const SECTIONS = ["featured", "merch", "food", "experiences"] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];
export type Section = (typeof SECTIONS)[number];

/** A reward as `GET …/events/{eventId}/rewards` answers it (API.md). */
export type RewardView = Readonly<{
  id: string;
  kind: RewardKind;
  name: Bilingual;
  description: Bilingual;
  price: number;
  stock: number;
  unitsOut: number;
  stockLeft: number;
  perPlayerLimit: number | null;
  opensAt: string | null;
  closesAt: string | null;
  section: Section | null;
  tags: Readonly<{ new: boolean; limited: boolean }>;
  /** A digital reward whose codes run low, or that has none yet (FR-512). */
  lowCodes: boolean;
}>;

export type ShopSettings = Readonly<{
  pickupMinutes: number;
  daysAfter: number;
  rules: Bilingual;
  spendLowersRank: boolean;
}>;

/** What the reward form holds: times as the wall clock in the event's zone, empty when not set; "" for no limit. */
export type RewardDraft = Readonly<{
  kind: RewardKind;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  price: number;
  stock: number;
  perPlayerLimit: string;
  opensAt: string;
  closesAt: string;
  section: Section | "";
  tagNew: boolean;
  tagLimited: boolean;
}>;

export function blankReward(): RewardDraft {
  return {
    kind: "item",
    nameAr: "",
    nameEn: "",
    descriptionAr: "",
    descriptionEn: "",
    price: 100,
    stock: 10,
    perPlayerLimit: "",
    opensAt: "",
    closesAt: "",
    section: "",
    tagNew: false,
    tagLimited: false,
  };
}

export function rewardDraftOf(reward: RewardView, timeZone: string): RewardDraft {
  const local = (iso: string | null) => (iso === null ? "" : toLocalInput(new Date(iso), timeZone));
  return {
    kind: reward.kind,
    nameAr: reward.name.ar ?? "",
    nameEn: reward.name.en ?? "",
    descriptionAr: reward.description.ar ?? "",
    descriptionEn: reward.description.en ?? "",
    price: reward.price,
    stock: reward.stock,
    perPlayerLimit: reward.perPlayerLimit === null ? "" : String(reward.perPlayerLimit),
    opensAt: local(reward.opensAt),
    closesAt: local(reward.closesAt),
    section: reward.section ?? "",
    tagNew: reward.tags.new,
    tagLimited: reward.tags.limited,
  };
}

const fieldsOf = (draft: RewardDraft): Record<string, unknown> => ({
  name: { ar: draft.nameAr, en: draft.nameEn },
  description: { ar: draft.descriptionAr, en: draft.descriptionEn },
  price: draft.price,
  stock: draft.stock,
  perPlayerLimit: draft.perPlayerLimit === "" ? null : Number(draft.perPlayerLimit),
  opensAt: draft.opensAt === "" ? null : draft.opensAt,
  closesAt: draft.closesAt === "" ? null : draft.closesAt,
  section: draft.section === "" ? null : draft.section,
  tags: { new: draft.tagNew, limited: draft.tagLimited },
});

/** The body to create a reward: everything, with its kind. A digital reward has no stock to send: its codes are it. */
export function createRewardBody(draft: RewardDraft): Record<string, unknown> {
  const { stock: _codes, ...withoutStock } = fieldsOf(draft);
  return draft.kind === "digital"
    ? { kind: draft.kind, ...withoutStock }
    : { kind: draft.kind, ...fieldsOf(draft) };
}

/** The body to edit a reward: only what changed (the kind never changes). */
export function editRewardBody(draft: RewardDraft, before: RewardDraft): Record<string, unknown> {
  const now = fieldsOf(draft);
  const then = fieldsOf(before);
  return Object.fromEntries(
    Object.entries(now).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(then[key]),
    ),
  );
}

export type RewardField = "name" | "price" | "stock" | "perPlayerLimit" | "closesAt";

const between = (value: number, low: number, high: number) =>
  Number.isInteger(value) && value >= low && value <= high;

/**
 * The first field the API would refuse, checked before sending with the same ranges (API.md). `unitsOut` is what is
 * reserved now: the stock may not go below it. Undefined when the draft is fine.
 */
export function rewardProblem(draft: RewardDraft, unitsOut = 0): RewardField | undefined {
  if (draft.nameAr.trim() === "" && draft.nameEn.trim() === "") {
    return "name";
  }
  if (!between(draft.price, 1, 1_000_000)) {
    return "price";
  }
  if (draft.kind !== "digital" && !between(draft.stock, Math.max(0, unitsOut), 100_000)) {
    return "stock";
  }
  if (draft.perPlayerLimit !== "" && !between(Number(draft.perPlayerLimit), 1, 100)) {
    return "perPlayerLimit";
  }
  if (draft.opensAt !== "" && draft.closesAt !== "" && draft.closesAt <= draft.opensAt) {
    return "closesAt";
  }
  return undefined;
}

export type ShopField = "pickupMinutes" | "daysAfter";

/** The shop settings' ranges (ADR-048, ADR-049): pickup 15 minutes to 7 days, the shop 0 to 30 days after the end. */
export function shopProblem(settings: ShopSettings): ShopField | undefined {
  if (!between(settings.pickupMinutes, 15, 10_080)) {
    return "pickupMinutes";
  }
  return between(settings.daysAfter, 0, 30) ? undefined : "daysAfter";
}

/** The body of `PUT …/shop`: rules left empty are sent as empty text, which clears them (the API takes no null). */
export function shopRequest(settings: ShopSettings): Record<string, unknown> {
  return {
    pickupMinutes: settings.pickupMinutes,
    daysAfter: settings.daysAfter,
    rules: { ar: settings.rules.ar ?? "", en: settings.rules.en ?? "" },
    spendLowersRank: settings.spendLowersRank,
  };
}

/** At most this many codes in one upload, as the API takes them (API.md). */
export const CODES_PER_UPLOAD = 5000;
const CODE_MAX_LENGTH = 200;
const CONTROL = /\p{Cc}/u;

export type CodesProblem = "empty" | "tooMany" | "badCode";

/**
 * The codes in pasted text or a text/CSV file, one per line (a Windows line end too), blank lines dropped. The API
 * normalizes and checks each again; this names the problem before sending.
 */
export function parseCodes(
  text: string,
): Readonly<{ codes: string[] } | { problem: CodesProblem }> {
  const codes = text
    .split(/\r?\n/)
    .map((line) => line.normalize("NFC").trim())
    .filter((line) => line !== "");
  if (codes.length === 0) {
    return { problem: "empty" };
  }
  if (codes.length > CODES_PER_UPLOAD) {
    return { problem: "tooMany" };
  }
  if (codes.some((code) => code.length > CODE_MAX_LENGTH || CONTROL.test(code))) {
    return { problem: "badCode" };
  }
  return { codes };
}

/**
 * A CSV file's first column, one line each (a quoted cell loses its quotes), so `CODE1,10 SAR` uploads `CODE1`. Pasted
 * text keeps whole lines: a code may hold a comma.
 */
export function firstColumn(csv: string): string {
  return csv
    .split(/\r?\n/)
    .map((line) => {
      const cell = line.startsWith('"')
        ? (/^"((?:[^"]|"")*)"/.exec(line)?.[1] ?? "")
        : line.split(",")[0];
      return (cell ?? "").replaceAll('""', '"');
    })
    .join("\n");
}

/** The digital rewards to warn about (FR-512), in the list's order. */
export function lowCodeRewards(rewards: readonly RewardView[]): RewardView[] {
  return rewards.filter((reward) => reward.lowCodes);
}
