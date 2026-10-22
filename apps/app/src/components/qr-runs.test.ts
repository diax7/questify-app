import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { darkRuns } from "#src/components/qr-runs.ts";

describe("darkRuns", () => {
  it("covers exactly the code's dark modules, row by row", () => {
    const text = "A".repeat(50);
    const { data, size } = encode(text, { ecc: "M", border: 4 });
    const drawing = darkRuns(text);
    expect(drawing.size).toBe(size);
    drawing.rows.forEach((runs, y) => {
      const painted = Array.from({ length: size }, () => false);
      for (const [x = 0, length = 0] of runs) {
        for (let i = x; i < x + length; i += 1) {
          painted[i] = true;
        }
      }
      expect(painted).toEqual(data[y]);
    });
  });
});
