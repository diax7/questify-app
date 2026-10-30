"use client";
import type { Language, SouvenirRule } from "@questify/shared";
import { SouvenirPreview } from "#src/components/SouvenirPreview.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Card, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

function Action({
  label,
  busy,
  act,
  primary = false,
}: {
  label: string;
  busy: boolean;
  act: () => void;
  primary?: boolean;
}) {
  return (
    <Button variant={primary ? "primary" : "quiet"} disabled={busy} onClick={act}>
      {label}
    </Button>
  );
}
type Props = {
  rule: SouvenirRule;
  language: Language;
  busy: boolean;
  archived: boolean;
  base: string;
  edit: () => void;
  activate: () => void;
  stop: () => void;
  remove: () => void;
};
export function SouvenirCard({
  rule,
  language,
  busy,
  archived,
  base,
  edit,
  activate,
  stop,
  remove,
}: Props) {
  const t = useTranslator(language);
  return (
    <Card as="article">
      <SouvenirPreview item={rule.item} language={language} />
      <SubHeading as="h2">{rule.item.name[language]}</SubHeading>
      <Toolbar>
        <Badge tone={rule.status === "active" ? "success" : "neutral"}>
          {t(`souvenir.${rule.status}`)}
        </Badge>
        <Muted as="span">
          {t(`souvenir.${rule.audience}`)}
          {rule.audience === "rank" ? ` (${rule.rankFrom}–${rule.rankTo})` : ""}
        </Muted>
      </Toolbar>
      <Muted>{t("souvenir.targets", { count: rule.targetCount })}</Muted>
      <Muted>{t("souvenir.granted", { count: rule.granted })}</Muted>
      {rule.waitingForResults ? (
        <Notice tone="info">
          {t("souvenir.waiting")}{" "}
          <TextLink href={`${base}/prizes`}>{t("souvenir.results")}</TextLink>
        </Notice>
      ) : null}
      {archived ? null : (
        <Toolbar>
          {rule.status === "draft" ? (
            <>
              <Action busy={busy} label={t("souvenir.edit")} act={edit} />
              <Action busy={busy} label={t("souvenir.activate")} act={activate} primary />
              <Action busy={busy} label={t("souvenir.remove")} act={remove} />
            </>
          ) : null}
          {rule.status === "active" ? (
            <Action busy={busy} label={t("souvenir.stop")} act={stop} />
          ) : null}
        </Toolbar>
      )}
    </Card>
  );
}
