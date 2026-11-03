"use client";

import type { Language, NoticesView } from "@questify/shared";
import { useState } from "react";
import { CatalogState, PairInputs } from "#src/components/CatalogParts.tsx";
import styles from "#src/components/catalog.module.css";
import { useSwitchWriter, type Writer } from "#src/components/useSwitchWriter.ts";
import {
  BANNER_PATH,
  EVENT_MAINTENANCE_PATH,
  GLOBAL_MAINTENANCE_PATH,
  NOTICES_API,
  NO_BANNER,
  NO_MESSAGE,
  bannerDraftOf,
  checkBanner,
  checkEventPause,
  checkGlobalPause,
  eventResumePath,
  markedFields,
  readNotices,
  type BannerDraft,
} from "#src/lib/console-notices.ts";
import type { MessageDraft } from "#src/lib/console-switches.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";

type PartProps = Readonly<{ language: Language; notices: NoticesView; writer: Writer }>;
type PausedEvent = NoticesView["maintenance"]["events"][number];

const isBlank = (draft: MessageDraft): boolean => draft.ar === "" && draft.en === "";

/** Pause play in every event with a message, or let it run again. */
function GlobalPause({ language, notices, writer }: PartProps) {
  const t = translatorFor(language);
  const paused = notices.maintenance.global;
  const [draft, setDraft] = useState<MessageDraft>(paused ?? NO_MESSAGE);
  const checked = checkGlobalPause(draft);
  return (
    <li className={styles.card} data-testid="maintenance-global">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (checked.ok) {
            void writer.put(GLOBAL_MAINTENANCE_PATH, checked.body);
          }
        }}
      >
        <Stack>
          <span className={styles.name}>
            {t("console.notices.global")}
            {paused === null ? null : <Badge tone="info">{t("console.notices.pause")}</Badge>}
          </span>
          <PairInputs
            language={language}
            label={t("console.switches.message")}
            field="message"
            value={draft}
            invalid={markedFields(!isBlank(draft), checked)}
            disabled={writer.busy}
            onChange={setDraft}
          />
          <Toolbar>
            <Button type="submit" disabled={writer.busy || !checked.ok}>
              {t("console.notices.pause")}
            </Button>
            {paused === null ? null : (
              <Button
                disabled={writer.busy}
                onClick={() => {
                  setDraft(NO_MESSAGE);
                  void writer.reset(GLOBAL_MAINTENANCE_PATH);
                }}
              >
                {t("console.notices.resume")}
              </Button>
            )}
          </Toolbar>
        </Stack>
      </form>
    </li>
  );
}

/** One paused event: its name and code, the message players see, and a way to let it play again. */
function PausedEventRow({
  language,
  event,
  writer,
}: Readonly<{ language: Language; event: PausedEvent; writer: Writer }>) {
  const t = translatorFor(language);
  const name = event.name[language] ?? event.name.en ?? event.name.ar ?? event.joinCode;
  return (
    <li data-testid="paused-event" data-code={event.joinCode}>
      <Stack>
        <span className={styles.name}>
          {name}
          <span className={styles.code} dir="ltr">
            {event.joinCode}
          </span>
        </span>
        <span>{event.message[language]}</span>
        <Toolbar>
          <Button
            disabled={writer.busy}
            onClick={() => void writer.reset(eventResumePath(event.eventId))}
          >
            {t("console.notices.events.resume", { name })}
          </Button>
        </Toolbar>
      </Stack>
    </li>
  );
}

/** The form that pauses one more event: its join code and the message, cleared once it is saved. */
function PauseEventForm({ language, writer }: Readonly<{ language: Language; writer: Writer }>) {
  const t = translatorFor(language);
  const [joinCode, setJoinCode] = useState("");
  const [draft, setDraft] = useState<MessageDraft>(NO_MESSAGE);
  const checked = checkEventPause(joinCode, draft);
  const marked = markedFields(joinCode !== "" || !isBlank(draft), checked);
  const save = async () => {
    if (checked.ok && (await writer.put(EVENT_MAINTENANCE_PATH, checked.body))) {
      setJoinCode("");
      setDraft(NO_MESSAGE);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Stack>
        <Field
          label={t("console.notices.events.code")}
          error={marked.has("joinCode") ? t("console.catalog.invalid") : undefined}
        >
          <Input
            dir="ltr"
            value={joinCode}
            disabled={writer.busy}
            onChange={(event) => setJoinCode(event.target.value)}
          />
        </Field>
        <PairInputs
          language={language}
          label={t("console.switches.message")}
          field="message"
          value={draft}
          invalid={marked}
          disabled={writer.busy}
          onChange={setDraft}
        />
        <Toolbar>
          <Button type="submit" disabled={writer.busy || !checked.ok}>
            {t("console.notices.events.pause")}
          </Button>
        </Toolbar>
      </Stack>
    </form>
  );
}

/** The events paused one by one, and the form that pauses another. */
function EventPauses({ language, notices, writer }: PartProps) {
  const t = translatorFor(language);
  const { events } = notices.maintenance;
  return (
    <li className={styles.card} data-testid="maintenance-events">
      <Stack>
        <span className={styles.name}>{t("console.notices.events")}</span>
        {events.length === 0 ? (
          <span>{t("console.notices.events.none")}</span>
        ) : (
          <ul className={styles.cards}>
            {events.map((event) => (
              <PausedEventRow
                key={event.eventId}
                language={language}
                event={event}
                writer={writer}
              />
            ))}
          </ul>
        )}
        <PauseEventForm language={language} writer={writer} />
      </Stack>
    </li>
  );
}

/** A start or end time box; it shows a refusal only when the form says it is marked. */
function TimeField({
  language,
  label,
  field,
  value,
  marked,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  label: string;
  field: "startsAt" | "endsAt";
  value: string;
  marked: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Field label={label} error={marked.has(field) ? t("console.catalog.invalid") : undefined}>
      <Input
        type="datetime-local"
        dir="ltr"
        value={value}
        disabled={disabled}
        data-field={field}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** The banner on Questify Home: its message and the window it shows in, in the admin's own time zone. */
function BannerForm({ language, notices, writer }: PartProps) {
  const t = translatorFor(language);
  const saved = notices.banner;
  const [draft, setDraft] = useState<BannerDraft>(() => bannerDraftOf(saved));
  const checked = checkBanner(draft);
  const marked = markedFields(
    draft.startsAt !== "" || draft.endsAt !== "" || !isBlank(draft.message),
    checked,
  );
  return (
    <li className={styles.card} data-testid="banner">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (checked.ok) {
            void writer.put(BANNER_PATH, checked.body);
          }
        }}
      >
        <Stack>
          <span className={styles.name}>{t("console.notices.banner")}</span>
          <PairInputs
            language={language}
            label={t("console.switches.message")}
            field="message"
            value={draft.message}
            invalid={marked}
            disabled={writer.busy}
            onChange={(message) => setDraft({ ...draft, message })}
          />
          <TimeField
            language={language}
            label={t("console.notices.banner.starts")}
            field="startsAt"
            value={draft.startsAt}
            marked={marked}
            disabled={writer.busy}
            onChange={(startsAt) => setDraft({ ...draft, startsAt })}
          />
          <TimeField
            language={language}
            label={t("console.notices.banner.ends")}
            field="endsAt"
            value={draft.endsAt}
            marked={marked}
            disabled={writer.busy}
            onChange={(endsAt) => setDraft({ ...draft, endsAt })}
          />
          <Toolbar>
            <Button type="submit" disabled={writer.busy || !checked.ok}>
              {t("console.notices.banner.save")}
            </Button>
            {saved === null ? null : (
              <Button
                disabled={writer.busy}
                onClick={() => {
                  setDraft(NO_BANNER);
                  void writer.reset(BANNER_PATH);
                }}
              >
                {t("console.notices.banner.remove")}
              </Button>
            )}
          </Toolbar>
        </Stack>
      </form>
    </li>
  );
}

/**
 * The Maintenance and banner tab of the Switches page (T-703b, FR-1771, FR-1772): pause play everywhere or in one event
 * (found by its join code) with a message in both languages, and schedule the banner of Questify Home. Saved at once to
 * the configuration the apps read; the tab is read again after every save.
 */
export function ConsoleNotices({ language }: Readonly<{ language: Language }>) {
  const { state, reload } = useConsoleRead(NOTICES_API, readNotices);
  const { writer, notice, problem } = useSwitchWriter(language, reload);
  return (
    <CatalogState language={language} catalog={{ state, reload, notice, problem }}>
      {(notices) => (
        <ul className={styles.cards}>
          <GlobalPause
            key={JSON.stringify(notices.maintenance.global)}
            language={language}
            notices={notices}
            writer={writer}
          />
          <EventPauses language={language} notices={notices} writer={writer} />
          <BannerForm
            key={JSON.stringify(notices.banner)}
            language={language}
            notices={notices}
            writer={writer}
          />
        </ul>
      )}
    </CatalogState>
  );
}
