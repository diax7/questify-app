import { describe, expect, it } from "vitest";
import {
  blankReward,
  CODES_PER_UPLOAD,
  createRewardBody,
  deskDraftOf,
  deskIsSet,
  deskProblem,
  deskRequest,
  nextWindow,
  editRewardBody,
  firstColumn,
  lowCodeRewards,
  parseCodes,
  rewardDraftOf,
  rewardProblem,
  daysRule,
  deskEndsBeforeClose,
  shopProblem,
  shopRequest,
  type RewardView,
  type ShopSettings,
} from "#src/lib/rewards.ts";

const VIEW: RewardView = {
  id: "r1",
  kind: "item",
  name: { ar: "هودي", en: null },
  description: { ar: null, en: "Warm" },
  price: 200,
  stock: 5,
  unitsOut: 2,
  stockLeft: 3,
  perPlayerLimit: 1,
  opensAt: "2030-01-01T07:00:00.000Z",
  closesAt: null,
  section: "merch",
  tags: { new: true, limited: false },
  lowCodes: false,
};

describe("reward drafts", () => {
  it("reads a reward into the event's wall clock, and back into a create body", () => {
    const draft = rewardDraftOf(VIEW, "Asia/Riyadh");
    expect(draft).toMatchObject({
      nameAr: "هودي",
      nameEn: "",
      perPlayerLimit: "1",
      opensAt: "2030-01-01T10:00",
      closesAt: "",
      section: "merch",
    });
    expect(createRewardBody(draft)).toEqual({
      kind: "item",
      name: { ar: "هودي", en: "" },
      description: { ar: "", en: "Warm" },
      price: 200,
      stock: 5,
      perPlayerLimit: 1,
      opensAt: "2030-01-01T10:00",
      closesAt: null,
      section: "merch",
      tags: { new: true, limited: false },
    });
  });

  it("sends only what changed on an edit, with cleared values as null", () => {
    const before = rewardDraftOf(VIEW, "Asia/Riyadh");
    expect(
      editRewardBody({ ...before, stock: 9, perPlayerLimit: "", section: "" }, before),
    ).toEqual({
      stock: 9,
      perPlayerLimit: null,
      section: null,
    });
    expect(editRewardBody(before, before)).toEqual({});
  });
});

describe("rewardProblem", () => {
  const fine = { ...blankReward(), nameEn: "Hoodie" };

  it("accepts a complete draft", () => {
    expect(rewardProblem(fine)).toBeUndefined();
  });

  it.each([
    ["no name in either language", { nameEn: " " }, "name"],
    ["a price of zero", { price: 0 }, "price"],
    ["a price that is not whole", { price: 1.5 }, "price"],
    ["a price too high", { price: 1_000_001 }, "price"],
    ["negative stock", { stock: -1 }, "stock"],
    ["a limit of zero", { perPlayerLimit: "0" }, "perPlayerLimit"],
    ["a limit over 100", { perPlayerLimit: "101" }, "perPlayerLimit"],
    [
      "a close before the open",
      { opensAt: "2030-01-02T10:00", closesAt: "2030-01-01T10:00" },
      "closesAt",
    ],
  ] as const)("names the field for %s", (_name, change, field) => {
    expect(rewardProblem({ ...fine, ...change })).toBe(field);
  });

  it("refuses a stock below what is reserved, and allows it at that count", () => {
    expect(rewardProblem({ ...fine, stock: 1 }, 2)).toBe("stock");
    expect(rewardProblem({ ...fine, stock: 2 }, 2)).toBeUndefined();
  });
});

const NO_DESK = { location: { ar: null, en: null }, pin: null, hours: null };

const SETTINGS: ShopSettings = {
  state: "open",
  closesAt: "2030-01-04T10:00:00.000Z",
  pickupMinutes: 120,
  daysAfter: 3,
  rules: { ar: null, en: null },
  spendLowersRank: false,
  desk: NO_DESK,
  handoverConfirm: "collect_first",
};

describe("shopProblem", () => {
  it("keeps the pickup time and the days after inside their ranges", () => {
    expect(shopProblem({ ...SETTINGS, pickupMinutes: 15, daysAfter: 0 })).toBeUndefined();
    expect(shopProblem({ ...SETTINGS, pickupMinutes: 10_080, daysAfter: 30 })).toBeUndefined();
    expect(shopProblem({ ...SETTINGS, pickupMinutes: 14 })).toBe("pickupMinutes");
    expect(shopProblem({ ...SETTINGS, daysAfter: 31 })).toBe("daysAfter");
    expect(shopProblem({ ...SETTINGS, daysAfter: -1 })).toBe("daysAfter");
    expect(shopProblem({ ...SETTINGS, daysAfter: 1.5 })).toBe("daysAfter");
  });

  it("before the end, any days in range are fine", () => {
    expect(shopProblem({ ...SETTINGS, daysAfter: 0 })).toBeUndefined();
  });

  it("after the end, refuses fewer days than the shop has and allows the same or more (ADR-336)", () => {
    const after = { storedDays: 3 };
    expect(shopProblem({ ...SETTINGS, daysAfter: 2 }, after)).toBe("daysAfterShorter");
    expect(shopProblem({ ...SETTINGS, daysAfter: 0 }, after)).toBe("daysAfterShorter");
    expect(shopProblem({ ...SETTINGS, daysAfter: 3 }, after)).toBeUndefined();
    expect(shopProblem({ ...SETTINGS, daysAfter: 4 }, after)).toBeUndefined();
    expect(shopProblem({ ...SETTINGS, daysAfter: 30 }, after)).toBeUndefined();
  });

  it("names a pickup time or a range problem before the shorter window", () => {
    expect(shopProblem({ ...SETTINGS, pickupMinutes: 5, daysAfter: 1 }, { storedDays: 3 })).toBe(
      "pickupMinutes",
    );
    expect(shopProblem({ ...SETTINGS, daysAfter: 31 }, { storedDays: 3 })).toBe("daysAfter");
  });
});

describe("daysRule", () => {
  it("lets the days change freely before the end, only grow after it, and not at all once closed", () => {
    expect(daysRule(SETTINGS, false)).toBe("free");
    expect(daysRule({ ...SETTINGS, state: "not_open" }, false)).toBe("free");
    expect(daysRule(SETTINGS, true)).toBe("onlyLonger");
    expect(daysRule({ ...SETTINGS, state: "closed" }, true)).toBe("frozen");
    expect(daysRule({ ...SETTINGS, state: "closed" }, false)).toBe("frozen");
  });
});

describe("shopRequest", () => {
  it("sends empty rules as empty text, never null, and the ranking choice", () => {
    const edited = {
      ...SETTINGS,
      pickupMinutes: 90,
      daysAfter: 2,
      rules: { ar: null, en: "One each" },
      spendLowersRank: true,
    };
    expect(shopRequest(edited, SETTINGS)).toEqual({
      pickupMinutes: 90,
      daysAfter: 2,
      rules: { ar: "", en: "One each" },
      spendLowersRank: true,
    });
  });

  it("sends the days only when they changed from what the page loaded (ADR-336)", () => {
    const sent = shopRequest({ ...SETTINGS, pickupMinutes: 90 }, SETTINGS);
    expect(sent).not.toHaveProperty("daysAfter");
    expect(sent).toMatchObject({ pickupMinutes: 90, spendLowersRank: false });
    expect(shopRequest({ ...SETTINGS, daysAfter: 5 }, SETTINGS)).toMatchObject({ daysAfter: 5 });
  });

  it("sends a change to 0 days, because 0 is a value and not 'unchanged'", () => {
    expect(shopRequest({ ...SETTINGS, daysAfter: 0 }, SETTINGS)).toMatchObject({ daysAfter: 0 });
  });

  it("never sends the days of a closed shop that the person could not change", () => {
    const closed = { ...SETTINGS, state: "closed" as const };
    expect(shopRequest({ ...closed, pickupMinutes: 60 }, closed)).not.toHaveProperty("daysAfter");
  });
});

const hoursEndingAt = (...ends: string[]) =>
  ends.map((end) => ({ opensAt: "2030-01-01T08:00:00.000Z", closesAt: end }));

describe("deskEndsBeforeClose (ADR-338)", () => {
  const closes = "2030-01-04T10:00:00.000Z";
  const shop = (ends: string[] | null, closesAt: string | null = closes): ShopSettings => ({
    ...SETTINGS,
    closesAt,
    desk: { ...NO_DESK, hours: ends === null ? null : hoursEndingAt(...ends) },
  });

  it("warns when the desk's last window ends before the shop closes", () => {
    expect(deskEndsBeforeClose(shop(["2030-01-02T18:00:00.000Z"]))).toBe(true);
    expect(
      deskEndsBeforeClose(shop(["2030-01-02T18:00:00.000Z", "2030-01-03T18:00:00.000Z"])),
    ).toBe(true);
  });

  it("judges by the latest end, whatever order the windows come in", () => {
    expect(
      deskEndsBeforeClose(shop(["2030-01-05T18:00:00.000Z", "2030-01-02T18:00:00.000Z"])),
    ).toBe(false);
  });

  it("does not warn when the desk ends at or after the close", () => {
    expect(deskEndsBeforeClose(shop([closes]))).toBe(false);
    expect(deskEndsBeforeClose(shop(["2030-01-06T18:00:00.000Z"]))).toBe(false);
  });

  it("does not warn once the shop has closed", () => {
    expect(deskEndsBeforeClose({ ...shop(["2030-01-02T18:00:00.000Z"]), state: "closed" })).toBe(
      false,
    );
    expect(deskEndsBeforeClose({ ...shop(["2030-01-02T18:00:00.000Z"]), state: "open" })).toBe(
      true,
    );
  });

  it("does not warn for a desk open the whole time, no windows, or a shop without a close date", () => {
    expect(deskEndsBeforeClose(shop(null))).toBe(false);
    expect(deskEndsBeforeClose(shop([]))).toBe(false);
    expect(deskEndsBeforeClose(shop(["2030-01-02T18:00:00.000Z"], null))).toBe(false);
  });
});

describe("digital rewards (T-203)", () => {
  it("creates a digital reward without a stock, and never checks one", () => {
    const draft = { ...blankReward(), kind: "digital" as const, nameEn: "Card", stock: -1 };
    expect(createRewardBody(draft)).not.toHaveProperty("stock");
    expect(createRewardBody(draft)).toMatchObject({ kind: "digital" });
    expect(rewardProblem(draft)).toBeUndefined();
    expect(createRewardBody({ ...draft, kind: "item" })).toHaveProperty("stock", -1);
  });

  it("reads codes one per line, trimmed and normalized, dropping blank lines", () => {
    expect(parseCodes(" A-1 \r\n\nB-2\n  \ne\u0301\n")).toEqual({
      codes: ["A-1", "B-2", "\u00e9"],
    });
  });

  it("names empty, oversized and broken uploads", () => {
    expect(parseCodes(" \n \n")).toEqual({ problem: "empty" });
    const many = Array.from({ length: CODES_PER_UPLOAD + 1 }, (_, i) => `C${i}`).join("\n");
    expect(parseCodes(many)).toEqual({ problem: "tooMany" });
    const most = Array.from({ length: CODES_PER_UPLOAD }, (_, i) => `C${i}`).join("\n");
    expect(parseCodes(most)).toMatchObject({ codes: expect.any(Array) });
    expect(parseCodes("A".repeat(201))).toEqual({ problem: "badCode" });
    expect(parseCodes("A".repeat(200))).toMatchObject({ codes: ["A".repeat(200)] });
    expect(parseCodes("A\tB")).toEqual({ problem: "badCode" });
  });

  it("takes a CSV's first column, unquoting a quoted cell", () => {
    expect(firstColumn('CODE1,10 SAR\r\n"A,""B""",x\nPLAIN\n')).toBe('CODE1\nA,"B"\nPLAIN\n');
  });

  it("lists only the rewards whose codes run low", () => {
    const low = { ...VIEW, id: "r2", kind: "digital" as const, lowCodes: true };
    expect(lowCodeRewards([VIEW, low])).toEqual([low]);
  });
});

describe("the prize desk (FR-1716, ADR-150)", () => {
  const SHOP = {
    state: "open" as const,
    closesAt: null,
    pickupMinutes: 120,
    daysAfter: 3,
    rules: { ar: null, en: null },
    spendLowersRank: false,
    desk: {
      location: { ar: "القاعة ب", en: null },
      pin: { lat: 24.7, lng: 46.6 },
      hours: [{ opensAt: "2030-01-01T13:00:00.000Z", closesAt: "2030-01-01T19:00:00.000Z" }],
    },
    handoverConfirm: "desk_offer" as const,
  };
  const draft = deskDraftOf(SHOP, "Asia/Riyadh");

  it("reads the desk into the form in the event's zone", () => {
    expect(draft).toEqual({
      locationAr: "القاعة ب",
      locationEn: "",
      lat: "24.7",
      lng: "46.6",
      hoursOn: true,
      windows: [{ opensAt: "2030-01-01T16:00", closesAt: "2030-01-01T22:00" }],
      confirm: "desk_offer",
    });
    expect(deskDraftOf({ ...SHOP, desk: NO_DESK }, "Asia/Riyadh")).toMatchObject({
      lat: "",
      lng: "",
      hoursOn: false,
      windows: [],
    });
  });

  it("knows a desk is set by either name, not by blanks", () => {
    expect(deskIsSet(SHOP.desk)).toBe(true);
    expect(deskIsSet({ ...NO_DESK, location: { ar: null, en: "Hall" } })).toBe(true);
    expect(deskIsSet({ ...NO_DESK, location: { ar: "  ", en: "" } })).toBe(false);
    expect(deskIsSet(NO_DESK)).toBe(false);
  });

  it("sends the pin and hours, null when off or not typed", () => {
    expect(deskRequest(draft)).toEqual({
      desk: {
        location: { ar: "القاعة ب", en: "" },
        pin: { lat: 24.7, lng: 46.6 },
        hours: [{ opensAt: "2030-01-01T16:00", closesAt: "2030-01-01T22:00" }],
      },
      handoverConfirm: "desk_offer",
    });
    expect(deskRequest({ ...draft, lat: " ", lng: "", hoursOn: false })).toMatchObject({
      desk: { pin: null, hours: null },
    });
  });

  it("finds the first problem with the pin and the hours", () => {
    expect(deskProblem(draft)).toBeUndefined();
    expect(deskProblem({ ...draft, lat: "", lng: "" })).toBeUndefined();
    expect(deskProblem({ ...draft, lat: "91" })).toBe("deskPin");
    expect(deskProblem({ ...draft, lng: "-180.5" })).toBe("deskPin");
    expect(deskProblem({ ...draft, lng: "" })).toBe("deskPin");
    expect(deskProblem({ ...draft, lat: "north" })).toBe("deskPin");
    expect(deskProblem({ ...draft, hoursOn: false, windows: [] })).toBeUndefined();
    expect(deskProblem({ ...draft, windows: [] })).toBe("deskHours");
    const day = { opensAt: "2030-01-01T10:00", closesAt: "2030-01-01T12:00" };
    expect(deskProblem({ ...draft, windows: Array.from({ length: 14 }, () => day) })).toBe(
      "deskHours",
    );
    expect(deskProblem({ ...draft, windows: [{ ...day, closesAt: "2030-01-01T10:00" }] })).toBe(
      "deskHours",
    );
    expect(deskProblem({ ...draft, windows: [{ ...day, opensAt: "" }] })).toBe("deskHours");
    expect(deskProblem({ ...draft, windows: [{ ...day, closesAt: "" }] })).toBe("deskHours");
    expect(
      deskProblem({
        ...draft,
        windows: [day, { opensAt: "2030-01-01T12:00", closesAt: "2030-01-01T14:00" }],
      }),
    ).toBeUndefined();
    expect(
      deskProblem({
        ...draft,
        windows: [day, { opensAt: "2030-01-01T11:59", closesAt: "2030-01-01T14:00" }],
      }),
    ).toBe("deskHours");
    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      opensAt: `2030-01-${String(i + 1).padStart(2, "0")}T10:00`,
      closesAt: `2030-01-${String(i + 1).padStart(2, "0")}T12:00`,
    }));
    expect(deskProblem({ ...draft, windows: fifteen })).toBe("deskHours");
    expect(deskProblem({ ...draft, windows: fifteen.slice(0, 14) })).toBeUndefined();
  });

  it("suggests the next window a day after the last, or an empty one", () => {
    expect(nextWindow([])).toEqual({ opensAt: "", closesAt: "" });
    expect(nextWindow([{ opensAt: "", closesAt: "2030-01-01T12:00" }])).toEqual({
      opensAt: "",
      closesAt: "",
    });
    expect(nextWindow([{ opensAt: "2030-01-31T16:00", closesAt: "2030-02-01T01:00" }])).toEqual({
      opensAt: "2030-02-01T16:00",
      closesAt: "2030-02-02T01:00",
    });
  });
});
