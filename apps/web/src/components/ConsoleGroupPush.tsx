"use client";

import {
  GROUP_PUSH_REACH_CAP,
  formatNumber,
  type GroupPushPreview,
  type Language,
} from "@questify/shared";
import { AudienceFields, TextFields } from "#src/components/GroupPushFields.tsx";
import { GroupPushHistory } from "#src/components/GroupPushHistory.tsx";
import { Problem } from "#src/components/ConsoleOversight.tsx";
import styles from "#src/components/catalog.module.css";
import { usePushComposer } from "#src/components/usePushComposer.tsx";
import { nameIn } from "#src/lib/console.ts";
import { GROUP_PUSH_API, isBlankPush, readPushes } from "#src/lib/console-group-push.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useInvitationCatalogs } from "#src/lib/use-invitation-catalogs.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";

const OPEN_STATUSES = ["scheduled", "live", "ended"] as const;

/** The line under the form that says who the reviewed send would reach. */
function reachText(preview: GroupPushPreview, language: Language): string {
  const t = translatorFor(language);
  if (preview.capped) {
    return t("console.push.reach.more", { count: formatNumber(GROUP_PUSH_REACH_CAP, language) });
  }
  const count = formatNumber(preview.reach, language);
  if (preview.event === null) {
    return t("console.push.reach.promo", { count });
  }
  const status = OPEN_STATUSES.find((one) => one === preview.event?.status);
  return t("console.push.reach.event", {
    name: nameIn(preview.event.name, language),
    code: preview.event.joinCode,
    status: status === undefined ? preview.event.status : t(`events.status.${status}`),
    count,
  });
}

/** Use the saved text, review who would receive the push, and send it once it was reviewed. */
function Buttons({
  language,
  composer,
}: Readonly<{ language: Language; composer: ReturnType<typeof usePushComposer> }>) {
  const t = translatorFor(language);
  const { checked, preview, busy, saved } = composer;
  return (
    <Toolbar>
      {saved === undefined ? null : (
        <Button variant="quiet" disabled={busy} onClick={() => composer.change(saved)}>
          {t("console.push.useSaved")}
        </Button>
      )}
      <Button type="submit" variant="secondary" disabled={busy || !checked.ok}>
        {t("console.push.review")}
      </Button>
      <Button disabled={busy || !checked.ok || preview === null} onClick={composer.askToSend}>
        {t("console.push.send")}
      </Button>
    </Toolbar>
  );
}

/**
 * The console's push to a group (T-706b, FR-1777): the audience (an event by its join code, or opted-in players by city
 * and interests), the title and text in both languages checked by the same rules as the API, a review that says who
 * would receive it, a confirmation, and the list of earlier sends.
 */
export function ConsoleGroupPush({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const history = useConsoleRead(GROUP_PUSH_API, readPushes);
  const catalogs = useInvitationCatalogs();
  const composer = usePushComposer(language, history.reload);
  const { draft, checked, preview, busy, change } = composer;
  return (
    <Stack>
      {composer.notice === null ? null : (
        <Notice tone="success" role="status">
          {composer.notice}
        </Notice>
      )}
      <Problem problem={composer.problem} />
      <form
        className={styles.card}
        data-testid="push-form"
        onSubmit={(event) => {
          event.preventDefault();
          void composer.review();
        }}
      >
        <Stack>
          <AudienceFields
            language={language}
            draft={draft}
            busy={busy}
            change={change}
            check={checked}
            catalogs={catalogs}
          />
          <TextFields
            language={language}
            draft={draft}
            busy={busy}
            change={change}
            check={checked}
            shown={!isBlankPush(draft)}
          />
          {preview === null ? null : (
            <Notice tone="info" role="status">
              <span data-testid="push-reach">{reachText(preview, language)}</span>
            </Notice>
          )}
          <Buttons language={language} composer={composer} />
        </Stack>
      </form>
      {history.state.kind === "failed" ? (
        <Muted role="status">{t("console.catalog.loadFailed")}</Muted>
      ) : null}
      {history.state.kind === "ready" ? (
        <GroupPushHistory language={language} pushes={history.state.value} catalogs={catalogs} />
      ) : null}
      {composer.dialog}
    </Stack>
  );
}
