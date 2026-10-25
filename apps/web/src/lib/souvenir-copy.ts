import type { SouvenirRule } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

/** The exact promise reviewed on activation; joined/rank never suggest that completing quests is required. */
export function souvenirAudienceCopy(
  t: Translate,
  rule: Pick<SouvenirRule, "audience" | "rankFrom" | "rankTo">,
) {
  if (rule.audience === "joined") return t("souvenir.joinedHint");
  if (rule.audience === "rank")
    return `${t("souvenir.rankHint", { from: rule.rankFrom ?? 1, to: rule.rankTo ?? 3 })} ${t("souvenir.rankSkip")}`;
  return t("souvenir.targetHint");
}

export function souvenirConfirmation(
  t: Translate,
  rule: SouvenirRule,
  name: string,
  categoryName: string,
) {
  const qualification = souvenirAudienceCopy(t, rule);
  const targets =
    rule.audience === "category" || rule.audience === "all"
      ? `${categoryName}. ${t("souvenir.targets", { count: rule.targetCount })}.`
      : "";
  return `${name}: ${t(`souvenir.${rule.audience}`)}. ${targets} ${qualification} ${t("souvenir.eligibility")} ${t("souvenir.promise")}`;
}
