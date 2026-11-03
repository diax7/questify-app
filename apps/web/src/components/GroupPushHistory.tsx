"use client";

import {
  formatNumber,
  type City,
  type GroupPushView,
  type Interest,
  type Language,
} from "@questify/shared";
import styles from "#src/components/catalog.module.css";
import { cityName } from "#src/lib/cities.ts";
import { nameIn } from "#src/lib/console.ts";
import { interestName } from "#src/lib/interests.ts";
import { riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Stack, SubHeading } from "#src/ui/Section.tsx";

type Catalogs = Readonly<{ cities: readonly City[]; interests: readonly Interest[] }>;

/** Where a promotional send went: the city, then the interests, or "every city" for neither. */
function whereText(
  push: GroupPushView,
  language: Language,
  catalogs: Catalogs,
  everywhere: string,
): string {
  const city = catalogs.cities.find((one) => one.id === push.cityId);
  const interests = push.interests.map((id) => {
    const known = catalogs.interests.find((one) => one.id === id);
    return known === undefined ? id : interestName(known, language);
  });
  const parts = [
    push.cityId === null ? null : city === undefined ? push.cityId : cityName(city, language),
    ...interests,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? everywhere : parts.join(", ");
}

function PushRow({
  language,
  push,
  catalogs,
}: Readonly<{ language: Language; push: GroupPushView; catalogs: Catalogs }>) {
  const t = translatorFor(language);
  const where = whereText(push, language, catalogs, t("console.push.row.anywhere"));
  const audience =
    push.event === null
      ? t("console.push.row.promo", { where })
      : t("console.push.row.event", {
          name: nameIn(push.event.name, language),
          code: push.event.joinCode,
        });
  const counts =
    push.audience === "event"
      ? t("console.push.row.counts.event", { reach: formatNumber(push.reach, language) })
      : t("console.push.row.counts.promo", {
          notices: formatNumber(push.notices, language),
          reach: formatNumber(push.reach, language),
          capped: formatNumber(push.capped, language),
        });
  return (
    <li className={styles.card} data-testid="push-row" data-state={push.state}>
      <div className={styles.head}>
        <span className={styles.name}>
          <span lang={language} dir="auto">
            {push.title[language]}
          </span>
          <Badge tone={push.state === "done" ? "success" : "info"}>
            {t(`console.push.state.${push.state}`)}
          </Badge>
        </span>
        <Muted as="span">{riyadhTime(push.createdAt, language)}</Muted>
      </div>
      <span lang={language} dir="auto">
        {push.body[language]}
      </span>
      <Muted>{audience}</Muted>
      <Muted>{counts}</Muted>
    </li>
  );
}

/** The last group pushes, newest first, with how far each has got. */
export function GroupPushHistory({
  language,
  pushes,
  catalogs,
}: Readonly<{ language: Language; pushes: readonly GroupPushView[]; catalogs: Catalogs }>) {
  const t = translatorFor(language);
  return (
    <Stack>
      <SubHeading as="h2">{t("console.push.history")}</SubHeading>
      {pushes.length === 0 ? (
        <Muted>{t("console.push.history.none")}</Muted>
      ) : (
        <ul className={styles.cards} data-testid="push-history">
          {pushes.map((push) => (
            <PushRow key={push.id} language={language} push={push} catalogs={catalogs} />
          ))}
        </ul>
      )}
    </Stack>
  );
}
