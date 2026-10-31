"use client";

import type { ChangeSetItem, Language } from "@questify/shared";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { fieldLabel, valueText } from "#src/lib/change-sets.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox } from "#src/ui/Field.tsx";
import { FactList, Row } from "#src/ui/Section.tsx";

const STATE_TONE = {
  ready: "info",
  invalid: "danger",
  stale: "warning",
  applied: "success",
  failed: "danger",
} as const;

/** The item's name in the page's language, then the other one, else "Unnamed". */
function nameOf(item: ChangeSetItem, language: Language, unnamed: string): string {
  const other = language === "ar" ? "en" : "ar";
  return item.name?.[language] ?? item.name?.[other] ?? unnamed;
}

/** What the item changes: each field with what it is now and what it becomes (an add has no "now"). */
export function ItemChanges({
  language,
  item,
}: Readonly<{ language: Language; item: ChangeSetItem }>) {
  const t = useTranslator(language);
  if (item.diff === null) {
    return null;
  }
  const { before, after } = item.diff;
  return (
    <FactList label={t("changeSets.fields")}>
      {Object.keys(after).map((field) => (
        <ChangedField
          key={field}
          label={fieldLabel(item.target, field, t)}
          now={item.op === "add" ? null : valueText(before[field], t)}
          next={valueText(after[field], t)}
          language={language}
        />
      ))}
    </FactList>
  );
}

function ChangedField({
  label,
  now,
  next,
  language,
}: Readonly<{ label: string; now: string | null; next: string; language: Language }>) {
  const t = useTranslator(language);
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {now === null ? null : (
          <span>
            {t("changeSets.now")}: <bdi>{now}</bdi>
            <br />
          </span>
        )}
        <span>
          {t("changeSets.new")}: <bdi>{next}</bdi>
        </span>
      </dd>
    </>
  );
}

/** The points and delete choices an item carries, in words (FR-1032). */
function ItemChoices({ language, item }: Readonly<{ language: Language; item: ChangeSetItem }>) {
  const t = useTranslator(language);
  const { apply, points, quests } = item.choices;
  const lines = [
    apply === "future" || apply === "past" ? t(`changeSets.choice.${apply}`) : null,
    points === "keep" || points === "remove" ? t(`changeSets.choice.${points}`) : null,
    quests === "move" ? t("changeSets.choice.move") : null,
    quests === "delete" ? t("changeSets.choice.deleteQuests") : null,
  ].filter((line) => line !== null);
  return (
    <>
      {lines.map((line) => (
        <Muted key={line}>{line}</Muted>
      ))}
    </>
  );
}

/** Why an item cannot be applied: its refusal in the API's own words, or that its target changed. */
function ItemProblem({ language, item }: Readonly<{ language: Language; item: ChangeSetItem }>) {
  const t = useTranslator(language);
  if (item.state === "stale") {
    return <Notice tone="warning">{t("changeSets.stale")}</Notice>;
  }
  return item.problem === null ? null : (
    <Notice tone="danger" role="alert">
      {describeProblem(item.problem, language, t).text}
    </Notice>
  );
}

/** One item of a set: whether it is selected, what it is, its state, what it changes and why it cannot be applied. */
export function ItemRow({
  language,
  item,
  checked,
  toggle,
}: Readonly<{
  language: Language;
  item: ChangeSetItem;
  checked: boolean;
  toggle: ((id: string) => void) | null;
}>) {
  const t = useTranslator(language);
  const label = (
    <>
      <strong>
        {t(`changeSets.op.${item.op}`)} · {t(`changeSets.target.${item.target}`)}
      </strong>{" "}
      <bdi>{nameOf(item, language, t("changeSets.unnamed"))}</bdi>
    </>
  );
  return (
    <Row
      main={
        <>
          {toggle === null || item.state !== "ready" ? (
            <span>{label}</span>
          ) : (
            <Checkbox label={label} checked={checked} onChange={() => toggle(item.id)} />
          )}
          <Badge tone={STATE_TONE[item.state]}>{t(`changeSets.state.${item.state}`)}</Badge>
          <ItemProblem language={language} item={item} />
          <ItemChoices language={language} item={item} />
          <ItemChanges language={language} item={item} />
        </>
      }
    />
  );
}
