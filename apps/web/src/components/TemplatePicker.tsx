"use client";

import {
  ACCENTS,
  QUEST_TYPES,
  templateTotals,
  type Language,
  type TemplateView,
} from "@questify/shared";
import { useId } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { switchesOf } from "#src/lib/templates.ts";
import { useTemplates } from "#src/lib/use-templates.ts";
import { Badge, Muted, Notice, ScreenReaderOnly, Swatch } from "#src/ui/Feedback.tsx";
import { FieldGroup, Radio } from "#src/ui/Field.tsx";
import { infoTip } from "#src/ui/info.tsx";
import { BulletList, Card, Rows, Row, Section, SubHeading } from "#src/ui/Section.tsx";

/** What one template sets up: counts, each category with its quests, the rewards, the switches and the accent. */
export function TemplatePreview({
  language,
  template,
}: Readonly<{ language: Language; template: TemplateView }>) {
  const t = useTranslator(language);
  const headingId = useId();
  const totals = templateTotals(template);
  const switches = switchesOf(template.features);
  return (
    <Card aria-labelledby={headingId}>
      <SubHeading id={headingId}>
        {t("templates.preview", { name: template.name[language] })}
      </SubHeading>
      <Muted>{t("templates.counts", totals)}</Muted>
      <Rows as="div">
        {template.categories.map((category) => (
          <Row
            as="div"
            key={category.name.en}
            main={
              <>
                <strong>{category.name[language]}</strong>
                <BulletList>
                  {category.quests.map((quest) => (
                    <li key={quest.title.en}>
                      {quest.title[language]}
                      {" · "}
                      {t(QUEST_TYPES[quest.type].label)}
                      {" · "}
                      {t("quests.pointsShort", { points: quest.points })}
                    </li>
                  ))}
                </BulletList>
              </>
            }
          />
        ))}
        <Row
          as="div"
          main={
            <>
              <strong>{t("rewards.title")}</strong>
              {infoTip(t, "templates.rewardsNote")}
              <BulletList>
                {template.rewards.map((reward) => (
                  <li key={reward.name.en}>
                    {reward.name[language]}
                    {" · "}
                    {t("rewards.priceShort", { points: reward.price })}
                  </li>
                ))}
              </BulletList>
            </>
          }
        />
        <Row
          as="div"
          main={
            <>
              <strong>{t("events.section.features")}</strong>
              <div>
                <Badge>
                  <Swatch color={ACCENTS[template.accent].hex} />
                  {t(ACCENTS[template.accent].label)}
                </Badge>{" "}
                {switches.map((one) => (
                  <Badge key={one.title} tone={one.on ? "success" : "neutral"}>
                    {t(one.on ? "templates.switchOn" : "templates.switchOff", {
                      name: t(one.title),
                    })}
                  </Badge>
                ))}
              </div>
            </>
          }
        />
      </Rows>
    </Card>
  );
}

/**
 * "Start from" (FR-1015): Start blank first, then each template with one line about it; the chosen template shows what it
 * sets up. A template that cannot be loaded leaves Start blank as the only choice. `value` is a template key, or null for blank;
 * `onChange` gets the chosen template, or null for blank.
 */
export function TemplatePicker({
  language,
  organizerId,
  value,
  onChange,
  disabled = false,
}: Readonly<{
  language: Language;
  organizerId: string;
  value: string | null;
  onChange: (template: TemplateView | null) => void;
  disabled?: boolean;
}>) {
  const t = useTranslator(language);
  const { templates, status } = useTemplates(organizerId);
  const chosen = templates.find((one) => one.key === value);
  return (
    <Section title={t("templates.title")}>
      {status === "failed" ? (
        <Notice tone="warning" role="status">
          {t("templates.loadFailed")}
        </Notice>
      ) : null}
      <FieldGroup
        legend={<ScreenReaderOnly>{t("templates.legend")}</ScreenReaderOnly>}
        layout="choiceGrid"
        disabled={disabled}
      >
        <Radio
          name="template"
          value=""
          checked={value === null}
          onChange={() => onChange(null)}
          label={t("templates.blank")}
        />
        {templates.map((one) => (
          <Radio
            key={one.key}
            name="template"
            value={one.key}
            checked={value === one.key}
            onChange={() => onChange(one)}
            label={one.name[language]}
            help={one.description[language]}
          />
        ))}
      </FieldGroup>
      {chosen === undefined ? null : <TemplatePreview language={language} template={chosen} />}
    </Section>
  );
}
