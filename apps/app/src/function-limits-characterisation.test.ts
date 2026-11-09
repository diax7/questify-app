// Characterisation of functions that were split to fit the function limits (docs/rules.md): each grid of inputs
// is run through the function and the outputs are fingerprinted. The fingerprints were taken from the code as it
// was before the split, so a refactor that changes any answer fails here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { CONFIG_KEY, loadConfig } from "#src/config/remote.ts";
import { scanStep, type ScanEvent, type ScanStep } from "#src/event/celebration.ts";
import { communityOf } from "#src/event/community.ts";
import { readQuests } from "#src/event/quests-api.ts";
import { rewardAction, type ShopReward, type ShopView } from "#src/event/shop-api.ts";
import { initialOf } from "#src/help/center.ts";
import { routeForIncoming } from "#src/join/deep-link.ts";

const fingerprint = (outputs: readonly unknown[]): string =>
  createHash("sha1")
    .update(outputs.map((output) => JSON.stringify(output) ?? "undefined").join("\n"))
    .digest("hex");

type Fields = Readonly<Record<string, readonly unknown[]>>;

/** Every combination of the listed values, as plain objects. */
function grid(fields: Fields): Record<string, unknown>[] {
  return Object.entries(fields).reduce<Record<string, unknown>[]>(
    (rows, [key, values]) =>
      rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value }))),
    [{}],
  );
}

const NOW = Date.parse("2030-01-01T10:00:00Z");

describe("rewardAction", () => {
  it("answers as before for every combination of its inputs", () => {
    const rows = grid({
      shopState: ["open", "closed"],
      locked: [false, true],
      kind: ["digital", "item"],
      desk: ["open", "finished"],
      reservation: [true, false],
      stockLeft: [0, 3],
      opensAt: [null, "2030-01-01T10:00:01Z", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"],
      closesAt: [null, "2030-01-01T10:00:01Z", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"],
      limit: [null, 1, 2],
      balance: [49, 50, 51],
    });
    const outputs = rows.map((row) =>
      rewardAction(
        {
          kind: row["kind"],
          price: 50,
          stockLeft: row["stockLeft"],
          perPlayerLimit: row["limit"],
          heldByMe: 1,
          opensAt: row["opensAt"],
          closesAt: row["closesAt"],
          communityLock: row["locked"] ? { goal: "g" } : null,
        } as unknown as ShopReward,
        {
          shop: {
            state: row["shopState"],
            desk: { state: row["desk"] },
            reservation: row["reservation"],
          },
          balance: row["balance"],
        } as unknown as ShopView,
        NOW,
      ),
    );
    expect(new Set(outputs).size).toBe(10);
    expect(fingerprint(outputs)).toBe("b8215e213c5be3f0752ecf154d978c5350bc8223");
  });
});

describe("initialOf", () => {
  it("answers as before for every combination of its inputs", () => {
    const rows = grid({
      card: [undefined, "", "report", "event", "app", "suggestion", "other"],
      kind: [undefined, "", "question", "problem", "prize", "other"],
      questId: [undefined, "q1"],
      questTitle: [undefined, "Title"],
    });
    const outputs = rows.map((row) =>
      initialOf(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))),
    );
    expect(fingerprint(outputs)).toBe("8925d4f66dae76c455a3a4c724f0324254ed6ddf");
  });
});

describe("routeForIncoming", () => {
  it("answers as before for invites, join links and everything else", () => {
    const token = "a".repeat(50);
    const incoming = [
      "",
      "/",
      `operator-invite/${token}`,
      `/operator-invite/${token}`,
      `/operator-invite/${"a".repeat(49)}`,
      `questify://operator-invite/${token}`,
      `https://app.questify.sa/op#${token}`,
      `https://app.questify.sa/op#invite=${token}`,
      "https://questify.sa/en/e/ABCD",
      "https://questify.sa/ar/e/ABCD2345?x=1",
      "https://questify.sa/ar/e/ABCD2345#frag",
      "https://questify.sa/fr/e/ABCD",
      "https://questify.sa/en/e/AB",
      "http://questify.sa/en/e/ABCD",
      "/en/e/abcd",
      "/ar/e/AbCd12/",
      "/ar/e/AbCd12?via=x",
      "/ar/e/AbCd12#x",
      "/ar/e/ABC",
      "/ar/e/ABCDEFGHIJKLM",
      "/fr/e/ABCD",
      "ABCD",
      "/join/ABCD",
      "https://example.com/other",
    ];
    expect(fingerprint(incoming.map(routeForIncoming))).toBe(
      "89cd2d8d9053327360f9f403f59ed7317fe35f65",
    );
    expect(routeForIncoming("/en/e/abcd")).toBe("/join/ABCD?via=link");
    expect(routeForIncoming("ABCD")).toBe("/");
    expect(routeForIncoming(`/operator-invite/${token}`)).toBe(`/operator-invite/${token}`);
  });
});

describe("scanStep", () => {
  it("answers as before for every step and event", () => {
    const steps: ScanStep[] = [
      { kind: "scanning" },
      { kind: "checking", questId: "q", token: "t" },
      { kind: "stamped", done: 1, needed: 2, fresh: true },
      { kind: "revealed", name: { ar: "a", en: "e" }, fresh: false },
      {
        kind: "celebrating",
        questId: "q",
        points: 1,
        replayed: false,
        levelUp: null,
        bonus: null,
        item: null,
        boosted: false,
        firstBonus: null,
        streakBonus: null,
        met: null,
        details: undefined,
      },
      { kind: "refused", answer: { kind: "limit" } },
      { kind: "lost", questId: "q", token: "t" },
    ];
    const completed = {
      kind: "completed",
      points: 5,
      score: 5,
      replayed: false,
      levelUp: null,
      bonus: null,
      item: null,
      firstBonus: null,
      streakBonus: null,
    };
    const answers: unknown[] = [
      { kind: "stamped", done: 2, needed: 3, fresh: false },
      { kind: "revealed", name: { ar: "a", en: "e" }, fresh: true },
      completed,
      { ...completed, boost: null },
      { ...completed, boost: { multiplier: 2 } },
      { ...completed, boost: undefined },
      { ...completed, questId: "other" },
      { ...completed, questId: undefined },
      { ...completed, met: { username: "sam" } },
      { ...completed, met: undefined },
      { kind: "network" },
      { kind: "limit" },
      { kind: "failed" },
      { kind: "signed_out" },
    ];
    const events: ScanEvent[] = [
      { type: "read", questId: "r", token: "rt" },
      {
        type: "details",
        details: { quest: undefined, finishedCategory: undefined, otherEvent: true },
      },
      { type: "retry" },
      { type: "again" },
      ...answers.map((answer) => ({ type: "answered", answer }) as unknown as ScanEvent),
    ];
    const outputs = steps.flatMap((step) => events.map((event) => scanStep(step, event)));
    expect(fingerprint(outputs)).toBe("6f90678138d11102716b39d6baf7364886c38e8a");
  });
});

const TEXT = { ar: "ع", en: "en" };
const STEP = {
  threshold: 10,
  isGoal: true,
  reward: { kind: "points", points: 5, moment: TEXT, target: { kind: "k", id: "i", name: TEXT } },
  reachedAt: "2030-01-01T00:00:00Z",
  mine: "paid",
};
const COMMUNITY = {
  goalId: "g",
  title: TEXT,
  measure: "points",
  target: 100,
  progress: 10,
  status: "running",
  paidTo: "everyone",
  endsAt: "2030-01-02T00:00:00Z",
  steps: [STEP],
  contributed: true,
};
const JUNK: readonly unknown[] = [undefined, null, 0, 7, "", "x", true, [], {}, [STEP], [null]];

describe("communityOf", () => {
  it("answers as before when each field is replaced by other values", () => {
    const outputs: unknown[] = [communityOf(COMMUNITY), communityOf(undefined), communityOf("x")];
    for (const key of Object.keys(COMMUNITY)) {
      for (const junk of [
        ...JUNK,
        "reached",
        "missed",
        "completions",
        "players",
        "contributors",
        "everyone",
      ]) {
        outputs.push(communityOf({ ...COMMUNITY, [key]: junk }));
      }
    }
    for (const key of Object.keys(STEP)) {
      for (const junk of [
        ...JUNK,
        "due",
        "skipped",
        { kind: "moment" },
        { kind: "x", points: 1 },
      ]) {
        outputs.push(communityOf({ ...COMMUNITY, steps: [{ ...STEP, [key]: junk }, STEP] }));
      }
    }
    outputs.push(communityOf({ ...COMMUNITY, steps: [STEP, null, STEP] }));
    outputs.push(communityOf({ ...COMMUNITY, steps: [] }));
    expect(fingerprint(outputs)).toBe("9ed791d8eb3f5668c6354b27fb107e34c8700fca");
    expect(communityOf(COMMUNITY)?.steps).toHaveLength(1);
  });
});

const QUEST: Record<string, unknown> = {
  id: "q1",
  title: TEXT,
  description: TEXT,
  type: "scan_qr",
  points: 10,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  done: 0,
  earned: 0,
  state: "open",
  verification: ["quest_qr"],
};
const EVENT = { statusNow: "live", timezone: "Asia/Riyadh" };

const view = (quest: unknown) =>
  readQuests({ event: EVENT, categories: [{ id: "c", name: TEXT, quests: [quest] }] });

describe("readQuests", () => {
  it("answers as before when each quest field is replaced by other values", () => {
    const outputs: unknown[] = [view(QUEST), view(null), view("x")];
    for (const key of Object.keys(QUEST)) {
      for (const junk of [
        ...JUNK,
        ["a", 1],
        ["a"],
        { ar: null, en: null },
        { ar: 1, en: null },
        { ar: "a" },
        "2030-01-01T00:00:00Z",
      ]) {
        outputs.push(view({ ...QUEST, [key]: junk }));
      }
      const { [key]: _removed, ...without } = QUEST;
      outputs.push(view(without));
    }
    expect(fingerprint(outputs)).toBe("612abfcaddd47e0ac8350ddd7d0c936c10add685");
    expect(view(QUEST)?.categories[0]?.quests[0]?.verification).toEqual(["quest_qr"]);
  });
});

const CONFIG = {
  schemaVersion: 1,
  features: {},
  tuning: {},
  legal: { documents: [{ id: "terms_of_use", version: "0.2" }] },
};

describe("loadConfig", () => {
  it("answers, asks and stores as before in every scenario", async () => {
    const answers: Record<string, AuthedResult> = {
      ok: { kind: "ok", status: 200, body: CONFIG, headers: new Headers({ etag: '"n"' }) },
      okNoTag: { kind: "ok", status: 200, body: CONFIG, headers: new Headers() },
      okBad: { kind: "ok", status: 200, body: { schemaVersion: 2 }, headers: new Headers() },
      notModified: {
        kind: "error",
        status: 304,
        code: "x",
        message: null,
        details: {},
        headers: new Headers(),
      },
      serverError: {
        kind: "error",
        status: 500,
        code: "x",
        message: null,
        details: {},
        headers: new Headers(),
      },
      network: { kind: "network" },
      signedOut: { kind: "signed_out" },
    };
    const stored: Record<string, string | undefined> = {
      none: undefined,
      good: JSON.stringify({ etag: '"v1"', body: CONFIG }),
      goodNoTag: JSON.stringify({ body: CONFIG }),
      badTag: JSON.stringify({ etag: 4, body: CONFIG }),
      badBody: JSON.stringify({ etag: '"v1"', body: { schemaVersion: 9 } }),
      noBody: JSON.stringify({ etag: '"v1"' }),
      junk: "{not json",
    };
    const outputs: unknown[] = [];
    for (const answer of Object.values(answers)) {
      for (const raw of Object.values(stored)) {
        for (const options of [
          {},
          { revalidate: false },
          { revalidate: true },
          { event: "e1" },
          { event: "e1", revalidate: false },
        ]) {
          const data = new Map<string, string>();
          const key = "event" in options ? `${CONFIG_KEY}.e1` : CONFIG_KEY;
          if (raw !== undefined) data.set(key, raw);
          const calls: ApiRequest[] = [];
          const written: string[] = [];
          const result = await loadConfig(
            {
              client: {
                request: async (request) => {
                  calls.push(request as ApiRequest);
                  return answer;
                },
              },
              store: {
                getItem: async (name) => data.get(name) ?? null,
                setItem: async (name, value) => {
                  written.push(`${name}=${value}`);
                  data.set(name, value);
                },
              },
            },
            options,
          );
          outputs.push({ result, calls, written });
        }
      }
    }
    expect(fingerprint(outputs)).toBe("148b812585c3e5e026cfda0a6c2428105d1c50a2");
  });
});
