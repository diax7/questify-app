import { describe, expect, it } from "vitest";
import { blankReward, rewardProblem } from "#src/lib/rewards.ts";

describe("rewardProblem edges", () => {
  const fine = { ...blankReward(), nameAr: "قبعة" };

  it("takes a name in either language and reports the first failing field", () => {
    expect(rewardProblem(fine)).toBeUndefined();
    expect(rewardProblem({ ...fine, nameAr: " ", nameEn: "" })).toBe("name");
    expect(rewardProblem({ ...fine, price: 0, stock: -1 })).toBe("price");
    expect(rewardProblem({ ...fine, stock: -1, perPlayerLimit: "0" })).toBe("stock");
    expect(rewardProblem({ ...fine, perPlayerLimit: "0", opensAt: "b", closesAt: "a" })).toBe(
      "perPlayerLimit",
    );
  });

  it("keeps the range ends and skips stock for a digital reward", () => {
    expect(rewardProblem({ ...fine, price: 1 })).toBeUndefined();
    expect(rewardProblem({ ...fine, price: 1_000_000 })).toBeUndefined();
    expect(rewardProblem({ ...fine, stock: 100_000 })).toBeUndefined();
    expect(rewardProblem({ ...fine, stock: 100_001 })).toBe("stock");
    expect(rewardProblem({ ...fine, perPlayerLimit: "1" })).toBeUndefined();
    expect(rewardProblem({ ...fine, perPlayerLimit: "100" })).toBeUndefined();
    expect(rewardProblem({ ...fine, kind: "digital", stock: -5 })).toBeUndefined();
    expect(rewardProblem({ ...fine, kind: "digital", stock: -5 }, 3)).toBeUndefined();
  });

  it("compares the window only when both ends are set, and refuses an equal one", () => {
    expect(rewardProblem({ ...fine, opensAt: "2030-01-01T10:00", closesAt: "" })).toBeUndefined();
    expect(rewardProblem({ ...fine, opensAt: "", closesAt: "2030-01-01T10:00" })).toBeUndefined();
    expect(
      rewardProblem({ ...fine, opensAt: "2030-01-01T10:00", closesAt: "2030-01-01T10:00" }),
    ).toBe("closesAt");
    expect(
      rewardProblem({ ...fine, opensAt: "2030-01-01T10:00", closesAt: "2030-01-01T10:01" }),
    ).toBeUndefined();
  });
});
