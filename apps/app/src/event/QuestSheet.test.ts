import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Quest } from "#src/event/quests-api.ts";
import type { CommunityLock } from "#src/event/unlock.ts";

const router = vi.hoisted(() => ({ push: vi.fn(), navigate: vi.fn() }));

vi.mock("react-native", () => ({}));
vi.mock("expo-router", () => ({ router }));
vi.mock("#src/api/app-session.ts", () => ({ api: {} }));
vi.mock("#src/api/uuid.ts", () => ({ randomUuid: () => "uuid" }));
vi.mock("#src/components/Amount.tsx", () => ({ Amount: "Amount" }));
vi.mock("#src/components/AppText.tsx", () => ({ AppText: "AppText" }));
vi.mock("#src/components/Controls.tsx", () => ({ Button: "Button", Field: "Field" }));
vi.mock("#src/components/Sheet.tsx", () => ({ Sheet: "Sheet" }));
vi.mock("#src/event/EventContext.tsx", () => ({ useEvent: () => ({}), useTerms: () => ({}) }));
vi.mock("#src/event/FirstBonusRibbon.tsx", () => ({ FirstBonusRibbon: "FirstBonusRibbon" }));
vi.mock("#src/event/GameEntry.tsx", () => ({ GameEntry: "GameEntry" }));
vi.mock("#src/event/LocationEntry.tsx", () => ({
  LocationEntry: "LocationEntry",
  useLocationReader: () => undefined,
}));
vi.mock("#src/event/MeetEntry.tsx", () => ({ MeetEntry: "MeetEntry" }));
vi.mock("#src/event/PassportEntry.tsx", () => ({ PassportEntry: "PassportEntry" }));
vi.mock("#src/event/QuestRating.tsx", () => ({ QuestRating: "QuestRating" }));
vi.mock("#src/event/QuizEntry.tsx", () => ({ QuizEntry: "QuizEntry" }));
vi.mock("#src/event/ShareEntry.tsx", () => ({ ShareEntry: "ShareEntry" }));
vi.mock("#src/event/SubmissionEntry.tsx", () => ({ SubmissionEntry: "SubmissionEntry" }));
vi.mock("#src/event/SurveyEntry.tsx", () => ({ SurveyEntry: "SurveyEntry" }));
vi.mock("#src/event/VoteEntry.tsx", () => ({ VoteEntry: "VoteEntry" }));
vi.mock("#src/i18n/provider.tsx", () => ({
  useI18n: () => ({ t: (key: string) => key, language: "en" }),
}));
vi.mock("#src/platform/current.ts", () => ({ platform: "ios" }));
vi.mock("#src/nfc/NfcTap.tsx", () => ({ useNfcSupported: () => true }));
vi.mock("#src/questify/ReportButton.tsx", () => ({ ReportButton: "ReportButton" }));

const { kioskAction, myQrAction, stateText, tapAction } = await import("#src/event/QuestSheet.tsx");

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`;

const quest = (patch: Partial<Quest> = {}): Quest => ({
  id: "quest-1",
  title: { ar: null, en: "Quest" },
  description: { ar: null, en: "" },
  type: "scan_qr",
  points: 10,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  done: 0,
  earned: 0,
  verification: [],
  state: "open",
  lock: null,
  steps: null,
  item: null,
  place: null,
  meet: null,
  game: null,
  submission: null,
  communityLock: null,
  flash: null,
  boost: null,
  firstBonus: null,
  ...patch,
});

const lock = (patch: Partial<CommunityLock>): CommunityLock => ({
  goalId: "goal-1",
  title: { ar: null, en: "Goal" },
  measure: "points",
  threshold: 1500,
  state: "waiting",
  startsAt: "2026-11-09T10:00:00Z",
  ...patch,
});

/** The props of an element, as the tree a render would hand to the native layer. */
const propsOf = (element: ReactElement | null) =>
  (element as ReactElement<Record<string, unknown>>).props;

/** The Button elements inside an action, whether the action is one button or a fragment of label and button. */
function buttonsOf(element: ReactElement | null): Record<string, unknown>[] {
  const root = propsOf(element);
  if ("label" in root) {
    return [root];
  }
  return [root["children"]]
    .flat()
    .filter((child): child is ReactElement => typeof child === "object" && child !== null)
    .map(propsOf)
    .filter((props) => "label" in props);
}

const stateOf = (state: Quest["state"]) => stateText(quest({ state }), t, "en", "Asia/Riyadh");

describe("stateText", () => {
  it("says nothing for an open quest and one about to open", () => {
    expect(stateText(quest({ state: "open" }), t, "en", "Asia/Riyadh")).toBeNull();
    expect(stateText(quest({ state: "not_yet" }), t, "en", "Asia/Riyadh")).toBeNull();
  });

  it("names why a quest cannot be played", () => {
    expect(stateOf("done")).toBe("questsTab.done");
    expect(stateOf("not_live")).toBe("questsTab.notLive");
    expect(stateOf("paused")).toBe("questsTab.paused");
    expect(stateOf("closed")).toBe("questsTab.closed");
    expect(stateOf("locked")).toBe("questsTab.locked");
  });

  it("calls a type this build does not know unknown, whatever its state", () => {
    expect(stateText(quest({ type: "hologram" }), t, "en", "Asia/Riyadh")).toBe(
      "questsTab.unknown",
    );
  });

  it("names the numbers of a community lock instead of the plain locked line", () => {
    const text = stateText(
      quest({ state: "locked", lock: "community_locked", communityLock: lock({}) }),
      t,
      "en",
      "Asia/Riyadh",
    );
    expect(text).toBe('community.unlock.points {"threshold":"1,500"}');
  });

  it("says when a scheduled community lock starts, in the event's zone", () => {
    const text = stateText(
      quest({
        state: "locked",
        communityLock: lock({ state: "scheduled", startsAt: "2026-11-09T10:00:00Z" }),
      }),
      t,
      "en",
      "Asia/Riyadh",
    );
    expect(text).toMatch(/^community\.unlock\.starts \{"time":".+"\}$/);
  });

  it("says a missed community goal is over", () => {
    const text = stateText(
      quest({ state: "locked", communityLock: lock({ state: "missed" }) }),
      t,
      "en",
      "Asia/Riyadh",
    );
    expect(text).toBe("community.unlock.missed {}");
  });

  it("ignores a community lock note on a quest that is not locked", () => {
    const text = stateText(
      quest({ state: "closed", communityLock: lock({}) }),
      t,
      "en",
      "Asia/Riyadh",
    );
    expect(text).toBe("questsTab.closed");
  });
});

/** The line above My QR's button. */
function staffLabel(type: string) {
  const [text] = [propsOf(myQrAction(quest({ type, verification: ["my_qr"] }), t))["children"]]
    .flat()
    .filter((child): child is ReactElement => typeof child === "object" && child !== null);
  return propsOf(text ?? null)["children"];
}

describe("myQrAction", () => {
  it("offers nothing when staff do not verify the quest", () => {
    expect(myQrAction(quest({ verification: ["quest_qr"] }), t)).toBeNull();
  });

  it("is the main button when My QR is the only way", () => {
    const [button] = buttonsOf(myQrAction(quest({ verification: ["my_qr"] }), t));
    expect(button).toMatchObject({ kind: "primary", label: "myQr.title" });
    const press = (button as Record<string, unknown>)["onPress"] as () => void;
    press();
    expect(router.push).toHaveBeenCalledWith("/my-qr");
  });

  it("steps back to a quiet button beside the printed code", () => {
    const [button] = buttonsOf(myQrAction(quest({ verification: ["my_qr", "quest_qr"] }), t));
    expect(button).toMatchObject({ kind: "quiet" });
  });

  it("explains a challenge as confirmed by staff and any other quest as showing My QR", () => {
    expect(staffLabel("challenge")).toBe("play.challenge.staff");
    expect(staffLabel("scan_qr")).toBe("quests.showMyQr");
  });
});

describe("kioskAction", () => {
  beforeEach(() => router.push.mockClear());

  it("offers nothing without the kiosk way", () => {
    expect(kioskAction(quest({ verification: ["quest_qr"] }))).toBeNull();
  });

  it("is primary when the kiosk is the only way and quiet beside others", () => {
    expect(propsOf(kioskAction(quest({ verification: ["kiosk"] })))).toEqual({ primary: true });
    expect(propsOf(kioskAction(quest({ verification: ["kiosk", "my_qr"] })))).toEqual({
      primary: false,
    });
  });
});

describe("tapAction", () => {
  const on = { on: true, supported: true as boolean | undefined };

  it("offers a tap only where NFC is on, the phone reads tags and the quest has one", () => {
    const nfc = quest({ verification: ["quest_qr", "nfc"] });
    expect(tapAction(nfc, "event-1", t, on)).not.toBeNull();
    expect(tapAction(nfc, "event-1", t, { on: false, supported: true })).toBeNull();
    expect(tapAction(nfc, "event-1", t, { on: true, supported: false })).toBeNull();
    expect(tapAction(nfc, "event-1", t, { on: true, supported: undefined })).toBeNull();
    expect(tapAction(quest({ verification: ["quest_qr"] }), "event-1", t, on)).toBeNull();
  });

  it("opens the scanner on the quest in tag mode", () => {
    const button = propsOf(tapAction(quest({ verification: ["nfc"] }), "event-1", t, on));
    expect(button["label"]).toBe("quests.action.tapNfc");
    (button["onPress"] as () => void)();
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/event/[eventId]/scan-quest",
      params: { eventId: "event-1", quest: "quest-1", nfc: "1" },
    });
  });
});
