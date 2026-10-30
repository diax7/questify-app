"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { EventFeatureSwitch } from "#src/components/EventFeatureSwitch.tsx";
import { DEFAULT_ZONE, zoneOf } from "#src/components/FinalePanel.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  DEFAULT_MOMENT_MINUTES,
  MOMENT_CHOICES,
  canStartCheers,
  cheersReadingOf,
  type CheersReading,
} from "#src/lib/cheers.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Field, Select } from "#src/ui/Field.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string; owner: boolean }>;
type Loaded = Readonly<{ reading: CheersReading; timeZone: string }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The Cheers reading and the event's zone together; why not, when the session is gone or the reading is unreadable. */
async function loadCheers(eventApi: string): Promise<Loaded | "session_lost" | "failed"> {
  const [cheers, event] = await Promise.all([
    requestJson("GET", `${eventApi}/cheers`),
    requestJson("GET", eventApi),
  ]);
  const code = errorCodeOf(cheers.body);
  if (code !== undefined && SESSION_LOST.has(code)) {
    return "session_lost";
  }
  const reading = cheers.ok ? cheersReadingOf(cheers.body) : undefined;
  return reading === undefined ? "failed" : { reading, timeZone: zoneOf(event) };
}

/** What the section reads; it reads again when a live moment's end passes, so the page never claims a finished moment. */
function useCheers({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [reading, setReading] = useState<CheersReading | null>(null);
  const [timeZone, setTimeZone] = useState(DEFAULT_ZONE);
  const [problem, setProblem] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const endsAt = reading?.endsAt ?? null;

  useEffect(() => {
    void loadCheers(eventApi).then((loaded) => {
      if (loaded === "session_lost") {
        window.location.assign(`/${language}/sign-in?ended=1`);
      } else if (loaded === "failed") {
        setProblem(t("cheers.loadFailed"));
      } else {
        setReading(loaded.reading);
        setTimeZone(loaded.timeZone);
      }
    });
  }, [eventApi, language, t, reloads]);
  useEffect(() => {
    if (endsAt === null) {
      return undefined;
    }
    const wait = Math.min(Math.max(Date.parse(endsAt) - Date.now() + 500, 500), 2_000_000_000);
    const timer = setTimeout(() => setReloads((count) => count + 1), wait);
    return () => clearTimeout(timer);
  }, [endsAt]);
  return { eventApi, reading, setReading, timeZone, problem, setProblem };
}

/** The moment's length, from the lengths offered. */
function LengthField({
  language,
  minutes,
  disabled,
  setMinutes,
}: Readonly<{
  language: Language;
  minutes: number;
  disabled: boolean;
  setMinutes: (minutes: number) => void;
}>) {
  const t = useTranslator(language);
  return (
    <Field label={t("cheers.minutes")}>
      <Select
        value={String(minutes)}
        disabled={disabled}
        onChange={(event) => setMinutes(Number(event.target.value))}
      >
        {MOMENT_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {t("cheers.minutesOption", { minutes: String(choice) })}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Start while no moment is live (when the add-on and both switches allow it); Stop while one is. */
function MomentButton({
  language,
  reading,
  locked,
  act,
}: Readonly<{
  language: Language;
  reading: CheersReading;
  locked: boolean;
  act: (action: "start" | "stop") => void;
}>) {
  const t = useTranslator(language);
  return (
    <Toolbar>
      {reading.endsAt === null ? (
        <Button
          variant="primary"
          disabled={locked || !canStartCheers(reading)}
          onClick={() => act("start")}
        >
          {t("cheers.start")}
        </Button>
      ) : (
        <Button variant="quiet" disabled={locked} onClick={() => act("stop")}>
          {t("cheers.stop")}
        </Button>
      )}
    </Toolbar>
  );
}

type MomentProps = Readonly<{
  language: Language;
  reading: CheersReading;
  timeZone: string;
  owner: boolean;
  busy: boolean;
  minutes: number;
  setMinutes: (minutes: number) => void;
  act: (action: "start" | "stop") => void;
}>;

/** The length to pick and Start while no moment is live; the end of the live one and Stop while one is. */
function MomentSection({
  language,
  reading,
  timeZone,
  owner,
  busy,
  minutes,
  setMinutes,
  act,
}: MomentProps) {
  const t = useTranslator(language);
  return (
    <Section title={t("cheers.title")}>
      {reading.platformOn ? null : <Muted>{t("cheers.platformOff")}</Muted>}
      {owner ? null : <Muted>{t("cheers.ownerOnly")}</Muted>}
      {reading.endsAt === null ? (
        <LengthField
          language={language}
          minutes={minutes}
          disabled={busy || !owner}
          setMinutes={setMinutes}
        />
      ) : (
        <Muted>
          {t("cheers.live", {
            time: formatEventTime(new Date(reading.endsAt), timeZone, language),
          })}
        </Muted>
      )}
      <MomentButton language={language} reading={reading} locked={busy || !owner} act={act} />
    </Section>
  );
}

/**
 * The Cheers part of the Big screen page (T-509, FR-1841): the event's Cheers switch, and the owner's start and stop for a
 * cheers moment of 1 to 30 minutes. While a moment is live the app shows its cheer button and the big screen runs the
 * Cheers scene alone.
 */
export function CheersPanel(props: Props) {
  const { language, organizerId, eventId, owner } = props;
  const t = useTranslator(language);
  const { eventApi, reading, setReading, timeZone, problem, setProblem } = useCheers(props);
  const [minutes, setMinutes] = useState(DEFAULT_MOMENT_MINUTES);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const act = useCallback(
    async (action: "start" | "stop") => {
      setBusy(true);
      setProblem(null);
      setNotice(null);
      const result = await requestJson(
        "POST",
        `${eventApi}/cheers/${action}`,
        action === "start" ? { minutes } : {},
        { "idempotency-key": crypto.randomUUID() },
      );
      setBusy(false);
      const next = result.ok ? cheersReadingOf(result.body) : undefined;
      if (next === undefined) {
        setProblem(describeProblem(result.body, language, t).text);
        return;
      }
      setReading(next);
      setNotice(t(action === "start" ? "cheers.started" : "cheers.stopped"));
    },
    [eventApi, minutes, language, t, setProblem, setReading],
  );

  return (
    <>
      <Notes
        problem={problem}
        notice={notice}
        loading={reading === null && problem === null}
        language={language}
      />
      {reading === null ? null : (
        <>
          <EventFeatureSwitch
            language={language}
            feature="cheers"
            organizerId={organizerId}
            eventId={eventId}
            initial={reading.switchOn}
            myRole={owner ? "owner" : "editor"}
            onSaved={(on) =>
              setReading((before) =>
                before === null
                  ? before
                  : { ...before, switchOn: on, endsAt: on ? before.endsAt : null },
              )
            }
          />
          <MomentSection
            language={language}
            reading={reading}
            timeZone={timeZone}
            owner={owner}
            busy={busy}
            minutes={minutes}
            setMinutes={setMinutes}
            act={(action) => void act(action)}
          />
        </>
      )}
    </>
  );
}
