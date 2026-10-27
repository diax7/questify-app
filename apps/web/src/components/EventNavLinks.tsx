"use client";

import { readEventTerms, termFor, type Language } from "@questify/shared";
import { HelpDeskLink } from "#src/components/HelpDeskPanel.tsx";
import { InvitationsLink } from "#src/components/InvitationsPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { EventView } from "#src/lib/events.ts";
import styles from "#src/components/layout.module.css";

/** An event's status, join code and the links to its pages, at the top of the event form. */
export function EventNavLinks({
  language,
  organizerId,
  event,
}: Readonly<{ language: Language; organizerId: string; event: EventView }>) {
  const t = useTranslator(language);
  const pages = `/${language}/organizers/${organizerId}/events`;
  const status = event.statusNow;
  const terms = readEventTerms(event.terms);
  return (
    <p className={styles.row}>
      <span className={styles.badge}>{t(`events.status.${status}`)}</span>
      <span dir="ltr">{t("events.joinCode", { code: event.joinCode })}</span>
      {status === "draft" ? <span className={styles.muted}>{t("events.draftNote")}</span> : null}
      <a className={styles.textLink} href={`${pages}/${event.id}/quests`}>
        {t("quests.title")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/rewards`}>
        {t("rewards.title")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/players`}>
        {t("players.title", { players: termFor(terms.player, language) })}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/operators`}>
        {t("operators.link")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/awards`}>
        {t("awards.link")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/submissions`}>
        {t("submissions.link")}
      </a>
      <HelpDeskLink language={language} organizerId={organizerId} eventId={event.id} />
      <a className={styles.textLink} href={`${pages}/${event.id}/flags`}>
        {t("flags.link")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/prizes`}>
        {t("prizes.link")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/community`}>
        {t("community.page.title")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/souvenirs`}>
        {t("souvenir.title")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/boosts`}>
        {t("boosts.page.title")}
      </a>
      <InvitationsLink language={language} organizerId={organizerId} eventId={event.id} />
      <a className={styles.textLink} href={`${pages}/${event.id}/joining`}>
        {t("joining.title")}
      </a>
      <a className={styles.textLink} href={`${pages}/${event.id}/devices`}>
        {t("devices.link")}
      </a>
    </p>
  );
}
