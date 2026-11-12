/** The photo wall's picker on the Big screen page (T-504b, FR-636): what `GET …/photo-wall` answers, and the pick. */

/** One photo the team may pick: a short signed read, its quest's title, and its place on the wall when picked. */
export type PickerPhoto = Readonly<{
  submissionId: string;
  url: string;
  questTitle: Readonly<{ ar: string | null; en: string | null }>;
}>;

export type PickerRead = Readonly<{
  picked: readonly PickerPhoto[];
  candidates: readonly PickerPhoto[];
  cursor: string | null;
}>;

/** At most this many photos on the wall (migration 0195's cap). */
export const WALL_MAX = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

function photoOf(value: unknown): PickerPhoto | undefined {
  if (!isRecord(value) || typeof value["submissionId"] !== "string") return undefined;
  const url = value["url"];
  if (typeof url !== "string" || !url.startsWith("https://")) return undefined;
  const title = isRecord(value["questTitle"]) ? value["questTitle"] : {};
  return {
    submissionId: value["submissionId"],
    url,
    questTitle: { ar: textOrNull(title["ar"]), en: textOrNull(title["en"]) },
  };
}

const photosOf = (value: unknown): readonly PickerPhoto[] =>
  Array.isArray(value)
    ? value.map(photoOf).filter((one): one is PickerPhoto => one !== undefined)
    : [];

/** The picker's reading, or undefined when the body is not one. */
export function pickerOf(body: unknown): PickerRead | undefined {
  if (!isRecord(body) || !Array.isArray(body["picked"]) || !Array.isArray(body["candidates"])) {
    return undefined;
  }
  return {
    picked: photosOf(body["picked"]),
    candidates: photosOf(body["candidates"]),
    cursor: textOrNull(body["cursor"]),
  };
}

/** The pick with a photo added at the end; unchanged when it is already there or the wall is full. */
export function addPick(
  picked: readonly PickerPhoto[],
  photo: PickerPhoto,
): readonly PickerPhoto[] {
  if (picked.length >= WALL_MAX || picked.some((one) => one.submissionId === photo.submissionId)) {
    return picked;
  }
  return [...picked, photo];
}

export const removePick = (picked: readonly PickerPhoto[], id: string): readonly PickerPhoto[] =>
  picked.filter((one) => one.submissionId !== id);

/** The pick with the photo at `index` moved by one place; unchanged at the ends. */
export function movePick(
  picked: readonly PickerPhoto[],
  index: number,
  by: -1 | 1,
): readonly PickerPhoto[] {
  const target = index + by;
  if (index < 0 || index >= picked.length || target < 0 || target >= picked.length) return picked;
  const next = [...picked];
  [next[index], next[target]] = [next[target] as PickerPhoto, next[index] as PickerPhoto];
  return next;
}

/** The candidates not on the wall yet, a later page's photos added once. */
export function morePhotos(
  shown: readonly PickerPhoto[],
  page: readonly PickerPhoto[],
): readonly PickerPhoto[] {
  const seen = new Set(shown.map((one) => one.submissionId));
  return [...shown, ...page.filter((one) => !seen.has(one.submissionId))];
}
