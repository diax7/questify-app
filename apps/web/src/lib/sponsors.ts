import {
  SPONSOR_TAG_KINDS,
  type Language,
  type MessageKey,
  type SponsorBody,
  type SponsorTagKind,
  type SponsorTier,
  type TeamSponsor,
} from "@questify/shared";

/** An event item a sponsor can be tagged to, named in the page's language. */
export type ItemChoice = Readonly<{ id: string; label: string }>;
export type TagChoices = Readonly<Record<SponsorTagKind, readonly ItemChoice[]>>;

/** A sponsor's fields as typed. */
export type SponsorDraft = {
  id: string | null;
  nameAr: string;
  nameEn: string;
  tier: SponsorTier;
  booth: string;
};

export const blankSponsor = (): SponsorDraft => ({
  id: null,
  nameAr: "",
  nameEn: "",
  tier: "gold",
  booth: "",
});

/** A saved sponsor as the form shows it. */
export const draftOf = (sponsor: TeamSponsor): SponsorDraft => ({
  id: sponsor.id,
  nameAr: sponsor.nameAr ?? "",
  nameEn: sponsor.nameEn ?? "",
  tier: sponsor.tier,
  booth: sponsor.booth ?? "",
});

const textOrNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** What the form sends. */
export const sponsorPayload = (draft: SponsorDraft): SponsorBody => ({
  nameAr: textOrNull(draft.nameAr),
  nameEn: textOrNull(draft.nameEn),
  tier: draft.tier,
  booth: textOrNull(draft.booth),
});

const ISSUE_KEYS: Readonly<Record<string, MessageKey>> = {
  name: "sponsors.issue.name",
  nameAr: "sponsors.issue.nameAr",
  nameEn: "sponsors.issue.nameEn",
  tier: "sponsors.issue.tier",
  booth: "sponsors.issue.booth",
  kind: "sponsors.issue.kind",
};

/** The message for a field the API or the database named; an unknown one reads as the general refusal. */
export const sponsorIssueKey = (issue: string): MessageKey =>
  ISSUE_KEYS[issue] ?? "sponsors.issue.sponsor";

/** A sponsor's name in the page's language, the other language's when it has only that one. */
export function sponsorName(sponsor: TeamSponsor, language: Language): string {
  const [first, second] =
    language === "ar" ? [sponsor.nameAr, sponsor.nameEn] : [sponsor.nameEn, sponsor.nameAr];
  return first ?? second ?? "";
}

type Text = { ar?: string | null; en?: string | null } | undefined;

const labelIn = (text: Text, language: Language): string => {
  const other = language === "ar" ? "en" : "ar";
  return text?.[language] ?? text?.[other] ?? "";
};

/** The quests and the categories of the builder's `GET …/quests`, in the page's language. */
export function questChoices(
  body: unknown,
  language: Language,
): Pick<TagChoices, "quest" | "category"> {
  const categories =
    (
      body as
        | { categories?: { id: string; name?: Text; quests?: { id: string; title?: Text }[] }[] }
        | undefined
    )?.categories ?? [];
  return {
    category: categories.map((category) => ({
      id: category.id,
      label: labelIn(category.name, language),
    })),
    quest: categories.flatMap((category) =>
      (category.quests ?? []).map((quest) => ({
        id: quest.id,
        label: labelIn(quest.title, language),
      })),
    ),
  };
}

/** The rewards of `GET …/rewards`, in the page's language. */
export function rewardChoices(body: unknown, language: Language): readonly ItemChoice[] {
  const rewards = (body as { rewards?: { id: string; name?: Text }[] } | undefined)?.rewards ?? [];
  return rewards.map((reward) => ({ id: reward.id, label: labelIn(reward.name, language) }));
}

/** The sponsor an item is tagged to, if any. */
export function sponsorOf(
  sponsors: readonly TeamSponsor[],
  kind: SponsorTagKind,
  targetId: string,
): TeamSponsor | undefined {
  return sponsors.find((sponsor) =>
    sponsor.tags.some((tag) => tag.kind === kind && tag.targetId === targetId),
  );
}

/** How many names the delete confirmation lists before it says "and N more". */
export const LISTED_NAMES = 6;

/** The names of the items a sponsor holds, in the order quests, categories, rewards; an item no longer listed is left out. */
export function taggedLabels(sponsor: TeamSponsor, choices: TagChoices): string[] {
  return SPONSOR_TAG_KINDS.flatMap((kind) =>
    sponsor.tags
      .filter((tag) => tag.kind === kind)
      .flatMap((tag) => choices[kind].find((choice) => choice.id === tag.targetId)?.label ?? []),
  );
}
