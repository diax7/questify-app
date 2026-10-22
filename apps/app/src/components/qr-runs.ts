import { encode } from "uqr";

/** Four light modules around the code: what scanners need to find its edge (ISO/IEC 18004). */
const QUIET_ZONE = 4;

/** Each row's dark modules as runs `[start, length]`: a few dozen views instead of one per module. */
export function darkRuns(text: string): Readonly<{ size: number; rows: number[][][] }> {
  const { data, size } = encode(text, { ecc: "M", border: QUIET_ZONE });
  const rows = data.map((row) => {
    const runs: number[][] = [];
    row.forEach((dark, x) => {
      const last = runs.at(-1);
      if (!dark) {
        return;
      }
      if (last !== undefined && (last[0] ?? 0) + (last[1] ?? 0) === x) {
        last[1] = (last[1] ?? 0) + 1;
      } else {
        runs.push([x, 1]);
      }
    });
    return runs;
  });
  return { size, rows };
}
