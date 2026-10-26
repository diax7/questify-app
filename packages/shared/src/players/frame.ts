export type FrameDesign = Readonly<{
  color: string;
  double: boolean;
  rounded: boolean;
  motif: boolean;
}>;

/**
 * The six gem shop rings (T-404, ADR-288): `frame-15` to `frame-20`. Their colours are not in the level frames' palette
 * so a bought ring never reads as a level reward, and each is dark enough for 3:1 on the page background.
 */
const SHOP_FRAMES: Readonly<Record<string, FrameDesign>> = {
  "frame-15": { color: "#7A3FB5", double: false, rounded: true, motif: true },
  "frame-16": { color: "#1F7F8C", double: true, rounded: false, motif: false },
  "frame-17": { color: "#B3261E", double: false, rounded: false, motif: true },
  "frame-18": { color: "#B4533A", double: true, rounded: true, motif: false },
  "frame-19": { color: "#6D5A8C", double: true, rounded: true, motif: true },
  "frame-20": { color: "#2C3E73", double: false, rounded: true, motif: false },
};

/** Finite shipped ring/motif vocabulary. Unknown future keys render no frame. */
export function frameDesign(key: string | null | undefined): FrameDesign | null {
  const shop = Object.hasOwn(SHOP_FRAMES, key ?? "") ? SHOP_FRAMES[key ?? ""] : undefined;
  if (shop !== undefined) return shop;
  const match = /^frame-(0[1-9]|1[0-4])$/.exec(key ?? "");
  if (match === null) return null;
  const index = Number(match[1]) - 1;
  return {
    color: ["#FFC94D", "#68C05B", "#4AA5E6", "#FF7A3D", "#FFA93C", "#E9D5B0", "#8B5A2B"][
      index % 7
    ] as string,
    double: index >= 7,
    rounded: index % 3 !== 1,
    motif: index % 2 === 0,
  };
}
