/** Finite shipped ring/motif vocabulary. Unknown future keys render no frame. */
export function frameDesign(key: string | null | undefined) {
  const match = /^frame-(0[1-9]|1[0-4])$/.exec(key ?? "");
  if (match === null) return null;
  const index = Number(match[1]) - 1;
  return {
    color: ["#FFC94D", "#68C05B", "#4AA5E6", "#FF7A3D", "#FFA93C", "#E9D5B0", "#8B5A2B"][index % 7],
    double: index >= 7,
    rounded: index % 3 !== 1,
    motif: index % 2 === 0,
  };
}
