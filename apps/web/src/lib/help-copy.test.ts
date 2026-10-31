import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "@questify/shared";

/**
 * Help text is a visible choice (ADR-370, rules.md "Copy and icons"). A page explains itself by its titles, labels and
 * icons; a line under a label that repeats or pads it is cut. What is left is listed here, so a new help key fails
 * this test until someone decides, in the diff, that it earns its place:
 *
 * - `HELP_LINES`: a short line that changes what the user does and the label cannot carry (a rule to meet, a warning
 *   that something cannot be undone, why a control is missing, an empty or locked state).
 * - `INFO_TIPS`: a real explanation, shown by an info button (`InfoTip`) beside its label on hover, focus or tap.
 *
 * A key is a help key when its name ends in hint, help, intro, note, about, blurb or lead. A line passed to a field,
 * section or page header as `help` or `description` is a help line whatever it is called, and must be listed too.
 */
const HELP_NAME = /(hint|help|intro|note|about|blurb|lead)$/i;

const HELP_LINES: readonly string[] = [
  "activation.editorHint",
  "activation.priceNote",
  "audience.rewardHint",
  "awards.capNote",
  "awards.removeBonusHint",
  "boosts.page.lockedNote",
  "boosts.page.rehearsalNote",
  "community.page.lockedNote",
  "community.page.titleHint",
  "console.daily.cadence.note",
  "console.daily.sponsorHelp",
  "console.invCampaign.field.closeNote",
  "console.invCampaign.field.note",
  "console.invCampaign.invalid.note",
  "console.note",
  "console.tickets.returnNote",
  "console.tickets.teamNote",
  "deletion.intro",
  "device.pair.scanHint",
  "devices.labelHint",
  "devices.removeNote",
  "events.endedHint",
  "events.liveHint",
  "events.streak.datesHint",
  "flags.note",
  "flags.pausedNote",
  "flags.removeHelp",
  "flags.speedNote",
  "invCampaign.card.note",
  "invCampaign.size.hint",
  "invCampaignPage.lead",
  "marketing.intro",
  "meet.codeHelp",
  "myQr.hint",
  "myQr.kioskHint",
  "operator.award.findHint",
  "operator.desk.findHint",
  "operator.emailHint",
  "operator.nfc.lockHint",
  "operator.practice.hint",
  "operator.ticket.replyHint",
  "operators.printHint",
  "play.game.quickNote",
  "pushSettings.offAbout",
  "quests.closedNote",
  "quests.field.codeHint",
  "quests.vote.sharesNote",
  "questsTab.codeHint",
  "rehearsal.joinIntro",
  "results.deadlineHint",
  "rewards.lowCodes.hint",
  "scanner.nfc.androidHint",
  "sessions.page.pointsNote",
  "shop.cancelClosedNote",
  "shop.collectHint",
  "shop.digitalNote",
  "shop.offerHint",
  "souvenir.joinedHint",
  "souvenir.rankHint",
  "souvenir.stopHint",
  "souvenir.targetHint",
  "staff.inviteEditorHint",
  "staff.transferHint",
  "tags.basicNote",
  "tags.qrNote",
  "terms.arHint",
  "terms.enHint",
  "tickets.escalate.note",
  "tickets.escalatedNote",
];

const INFO_TIPS: readonly string[] = [
  "alerts.hint",
  "announcements.page.intro",
  "audience.intro",
  "awards.bulkHelp",
  "awards.capsHelp",
  "awards.reasonHelp",
  "bigScreen.intro",
  "boosts.page.intro",
  "codes.secretHint",
  "community.page.intro",
  "community.page.unlock.note",
  "console.invCampaign.channel.hint",
  "console.invCampaign.sendAt.hint",
  "console.seasons.intro",
  "devices.intro",
  "events.city.hint",
  "events.field.dayStartHint",
  "events.interests.hint",
  "events.ranking.hint",
  "events.ranking.todayHint",
  "events.streak.bonusHint",
  "events.streak.intro",
  "events.streak.weekdaysHint",
  "events.venuePin.help",
  "exclusions.intro",
  "finale.intro",
  "flags.intro",
  "guests.intro",
  "guests.tagHint",
  "invCampaign.intro",
  "invCampaign.sendAfter.hint",
  "joinFields.choiceHint",
  "joinFields.intro",
  "joinRules.domainsHint",
  "joinRules.welcomeHint",
  "maps.page.boardHint",
  "maps.page.intro",
  "operators.intro",
  "prizes.intro",
  "prizes.rulesHint",
  "pushDefaults.hint",
  "pushTopic.announcements.about",
  "pushTopic.community.about",
  "pushTopic.rank.about",
  "pushTopic.reminders.about",
  "pushTopics.intro",
  "questItems.intro",
  "quests.challenge.note",
  "quests.field.flashHint",
  "quests.field.hiddenHint",
  "quests.field.refreshHint",
  "quests.field.rulesHint",
  "quests.field.windowHint",
  "quests.game.note",
  "quests.location.note",
  "quests.meet.note",
  "quests.passport.note",
  "quests.place.help",
  "quests.quiz.note",
  "quests.share.note",
  "quests.survey.note",
  "quests.verification.kioskHint",
  "quests.verification.screenQrHint",
  "quests.vote.note",
  "rewards.desk.hoursHint",
  "rewards.spendLowersRank.hint",
  "sessions.page.intro",
  "sponsors.page.intro",
  "terms.intro",
  "wizard.quests.nfcHint",
];

/** Keys shown as a `help` or `description` line whose names do not say so: a count, who is signed in, a state. */
const HELP_PROP_KEYS: readonly string[] = [
  "announcements.page.counter",
  "awards.capsOwnerOnly",
  "events.city.locked",
  "events.interests.full",
  "joinRules.welcomeLocked",
  "players.ownerOnly",
  "requests.count",
  "souvenir.resultsDepth",
  "staff.codeSent",
  "staff.passwordRules",
  "staff.signedInAs",
];

const SRC = join(__dirname, "..");

const helpKeysInMessages = (): string[] =>
  Object.keys(MESSAGES).filter((key) => HELP_NAME.test(key.split(".").pop() ?? ""));

function sourceFiles(): string[] {
  return readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".tsx") && !/\.test\./.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The text between the braces of a `help={...}` or `description={...}` prop, found by matching braces. */
function propExpressions(source: string): string[] {
  const found: string[] = [];
  for (const start of source.matchAll(/\b(?:help|description)=\{/g)) {
    let depth = 0;
    for (let at = start.index + start[0].length - 1; at < source.length; at += 1) {
      depth += source[at] === "{" ? 1 : source[at] === "}" ? -1 : 0;
      if (depth === 0) {
        found.push(source.slice(start.index + start[0].length, at));
        break;
      }
    }
  }
  return found;
}

describe("help text (ADR-370)", () => {
  it("lists every help key, so a new one is a visible choice", () => {
    const listed = new Set([...HELP_LINES, ...INFO_TIPS]);
    const unlisted = helpKeysInMessages().filter((key) => !listed.has(key));
    expect(
      unlisted,
      "A new help key: cut the line (the page's titles, labels and icons should explain it), or put a real explanation in an InfoTip. Add the key to HELP_LINES or INFO_TIPS only when it earns its place.",
    ).toEqual([]);
  });

  it("lists no key that is gone or is not a help key", () => {
    const helpKeys = new Set(helpKeysInMessages());
    expect([...HELP_LINES, ...INFO_TIPS].filter((key) => !helpKeys.has(key))).toEqual([]);
    expect(HELP_LINES.filter((key) => INFO_TIPS.includes(key))).toEqual([]);
  });

  it("keeps each list in order, so a change reads as one line in a diff", () => {
    for (const list of [HELP_LINES, INFO_TIPS, HELP_PROP_KEYS]) {
      expect([...list]).toEqual([...list].toSorted());
    }
  });

  it("allows a help or description prop only for a listed help line", () => {
    const allowed = new Set([...HELP_LINES, ...HELP_PROP_KEYS]);
    const unlisted: string[] = [];
    for (const file of sourceFiles()) {
      for (const expression of propExpressions(readFileSync(file, "utf8"))) {
        for (const match of expression.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) {
          const key = match[1] ?? "";
          if (key in MESSAGES && !allowed.has(key)) {
            unlisted.push(`${file}: ${key}`);
          }
        }
      }
    }
    expect(unlisted).toEqual([]);
  });

  it("names every key a help prop lists", () => {
    expect(HELP_PROP_KEYS.filter((key) => !(key in MESSAGES))).toEqual([]);
  });
});
