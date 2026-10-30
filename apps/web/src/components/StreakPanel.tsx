"use client";

import { termFor, type EventTerms, type Language, type StreakSettings } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { NumberField } from "#src/components/NumberField.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import {
  WEEKDAYS,
  addClosedDay,
  bodyOf,
  dayAfter,
  draftOf,
  hasStarted,
  isolatedDay,
  previewOf,
  refusalOf,
  removeClosedDay,
  settingsOf,
  toggleWeekday,
  type StreakDraft,
} from "#src/lib/streak.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Form, Input } from "#src/ui/Field.tsx";
import { Row, Rows, Section, Toolbar } from "#src/ui/Section.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
  terms: EventTerms;
}>;

type Loaded = Readonly<{ settings: StreakSettings; draft: StreakDraft }>;

/** One Idempotency-Key per distinct body: a retry of the same save replays the first answer. */
function useIdempotencyKey(): (body: unknown) => string {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (body) => {
    const text = JSON.stringify(body);
    if (last.current?.body !== text) {
      last.current = { body: text, key: crypto.randomUUID() };
    }
    return last.current.key;
  };
}

/**
 * The preview line: nothing, the streak alone, or the streak with its bonus in the event's currency word. Not a live
 * region: it changes with every keystroke, and only the save's answer is announced.
 */
function PreviewLine({
  language,
  draft,
  terms,
}: Readonly<{ language: Language; draft: StreakDraft; terms: EventTerms }>) {
  const t = useTranslator(language);
  const preview = previewOf(draft);
  return (
    <Muted>
      {preview.key === "events.streak.preview.bonus"
        ? t(preview.key, {
            points: preview.points,
            currency: termFor(terms.currency, language, preview.points),
          })
        : t(preview.key)}
    </Muted>
  );
}

/** The closed dates: each removable while it is upcoming, fixed once it has started; a picker adds more. */
function ClosedDates({
  language,
  draft,
  today,
  busy,
  change,
}: Readonly<{
  language: Language;
  draft: StreakDraft;
  today: string;
  busy: boolean;
  change: (next: StreakDraft) => void;
}>) {
  const t = useTranslator(language);
  const [picked, setPicked] = useState("");
  const [invalid, setInvalid] = useState(false);
  const add = () => {
    const next = addClosedDay(draft, picked, today);
    setInvalid(next === undefined);
    if (next !== undefined) {
      change(next);
      setPicked("");
    }
  };
  return (
    <FieldGroup legend={t("events.streak.closedDays")} help={t("events.streak.datesHint")}>
      {draft.closedDays.length === 0 ? null : (
        <Rows>
          {draft.closedDays.map((day) => (
            <Row
              key={day}
              main={
                <span dir="ltr">
                  {hasStarted(day, today)
                    ? t("events.streak.dayStarted", { day: isolatedDay(day) })
                    : day}
                </span>
              }
            >
              {hasStarted(day, today) ? null : (
                <Button
                  variant="quiet"

                  disabled={busy}
                  onClick={() => change(removeClosedDay(draft, day))}
                >
                  {t("events.streak.removeDate", { day: isolatedDay(day) })}
                </Button>
              )}
            </Row>
          ))}
        </Rows>
      )}
      <Field label={t("events.streak.dateField")}>
        <Input
          type="date"
          dir="ltr"
          min={dayAfter(today)}
          value={picked}
          disabled={busy}
          aria-invalid={invalid}
          onChange={(changed) => {
            setPicked(changed.target.value);
            setInvalid(false);
          }}
        />
      </Field>
      <Toolbar>
        <Button variant="secondary" disabled={busy || picked === ""} onClick={add}>
          {t("events.streak.addDate")}
        </Button>
      </Toolbar>
      {invalid ? (
        <Notice tone="danger" role="alert">
          {t("events.streak.dateInvalid")}
        </Notice>
      ) : null}
    </FieldGroup>
  );
}

/** What an editor sees: the state, the bonus line and the closed days, with no controls. */
function ReadOnly({
  language,
  settings,
  terms,
}: Readonly<{ language: Language; settings: StreakSettings; terms: EventTerms }>) {
  const t = useTranslator(language);
  const separator = language === "ar" ? "، " : ", ";
  const weekdays = WEEKDAYS.filter(({ day }) => settings.closedWeekdays.includes(day))
    .map(({ label }) => t(label))
    .join(separator);
  return (
    <>
      <PreviewLine language={language} draft={draftOf(settings)} terms={terms} />
      {weekdays === "" ? null : (
        <Muted>
          {t("events.streak.weekdays")}: {weekdays}
        </Muted>
      )}
      {settings.closedDays.length === 0 ? null : (
        <Muted>
          {t("events.streak.closedDays")}:{" "}
          <span dir="ltr">{settings.closedDays.join(separator)}</span>
        </Muted>
      )}
    </>
  );
}

type Panel = Readonly<{
  loaded: Loaded | "loading" | "failed";
  busy: boolean;
  problem: string | null;
  saved: boolean;
  invalidBonus: boolean;
  load: () => Promise<void>;
  edit: (draft: StreakDraft) => void;
  clearBonusProblem: () => void;
  save: (event: FormEvent) => Promise<void>;
}>;

/** Reads the settings once per event and saves the whole draft; the API's refusals become words. */
function useStreakPanel(language: Language, organizerId: string, eventId: string): Panel {
  const t = useTranslator(language);
  const [loaded, setLoaded] = useState<Loaded | "loading" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [invalidBonus, setInvalidBonus] = useState(false);
  const keyFor = useIdempotencyKey();
  const path = `/v1/organizers/${organizerId}/events/${eventId}/streak`;

  const lostSession = (body: unknown): boolean => {
    const code = errorCodeOf(body);
    if (code === undefined || !SESSION_LOST.has(code)) {
      return false;
    }
    window.location.assign(`/${language}/sign-in?ended=1`);
    return true;
  };

  const load = async () => {
    setLoaded("loading");
    const result = await requestJson("GET", path);
    if (!result.ok && lostSession(result.body)) {
      return;
    }
    const settings = result.ok ? settingsOf(result.body) : undefined;
    setLoaded(settings === undefined ? "failed" : { settings, draft: draftOf(settings) });
  };

  useEffect(() => {
    void load();
    // Once per page: the settings are read again only by Retry or after a save.
  }, [path]);

  const edit = (draft: StreakDraft) => {
    if (typeof loaded === "object") {
      setLoaded({ ...loaded, draft });
      setSaved(false);
    }
  };

  const refusalText = (body: unknown): string => {
    const refusal = refusalOf(body);
    return refusal === undefined
      ? describeProblem(body, language, t).text
      : t(refusal.key, refusal.day === undefined ? {} : { day: isolatedDay(refusal.day) });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (typeof loaded !== "object") {
      return;
    }
    const checked = bodyOf(loaded.draft);
    setInvalidBonus(!checked.ok && checked.field === "bonusPoints");
    if (!checked.ok) {
      setProblem(t(`events.streak.invalid.${checked.field}`));
      return;
    }
    setBusy(true);
    setProblem(null);
    setSaved(false);
    const result = await requestJson("PUT", path, checked.body, {
      "idempotency-key": keyFor(checked.body),
    });
    setBusy(false);
    if (!result.ok && lostSession(result.body)) {
      return;
    }
    const settings = result.ok ? settingsOf(result.body) : undefined;
    if (settings === undefined) {
      setProblem(refusalText(result.body));
      return;
    }
    setLoaded({ settings, draft: draftOf(settings) });
    setSaved(true);
  };

  return {
    loaded,
    busy,
    problem,
    saved,
    invalidBonus,
    load,
    edit,
    clearBonusProblem: () => setInvalidBonus(false),
    save,
  };
}

/** The owner's form: the switch, the bonus, the closed weekdays and dates, the preview and Save. */
function OwnerForm({
  language,
  loaded,
  panel,
  terms,
}: Readonly<{ language: Language; loaded: Loaded; panel: Panel; terms: EventTerms }>) {
  const t = useTranslator(language);
  const { draft, settings } = loaded;
  return (
    <Form onSubmit={(event) => void panel.save(event)}>
      <Checkbox
        label={t("events.streak.label")}
        checked={draft.enabled}
        disabled={panel.busy}
        onChange={(changed) => panel.edit({ ...draft, enabled: changed.target.checked })}
      />
      <NumberField
        label={t("events.streak.bonus", { currency: termFor(terms.currency, language) })}
        info={<InfoTip label={t("common.info")}>{t("events.streak.bonusHint")}</InfoTip>}
        value={draft.bonus}
        invalid={panel.invalidBonus}
        disabled={panel.busy}
        change={(bonus) => {
          panel.clearBonusProblem();
          panel.edit({ ...draft, bonus });
        }}
      />
      <FieldGroup
        legend={t("events.streak.weekdays")}
        info={<InfoTip label={t("common.info")}>{t("events.streak.weekdaysHint")}</InfoTip>}
        layout="choiceGrid"
      >
        {WEEKDAYS.map(({ day, label }) => (
          <Checkbox
            key={day}
            label={t(label)}
            checked={draft.closedWeekdays.includes(day)}
            disabled={panel.busy}
            onChange={() => panel.edit(toggleWeekday(draft, day))}
          />
        ))}
      </FieldGroup>
      <ClosedDates
        language={language}
        draft={draft}
        today={settings.today}
        busy={panel.busy}
        change={panel.edit}
      />
      <PreviewLine language={language} draft={draft} terms={terms} />
      <Button variant="primary" type="submit" disabled={panel.busy}>
        {t("events.streak.save")}
      </Button>
    </Form>
  );
}

/** The panel while the settings load, when they could not be read, and once they have. */
function PanelBody({
  language,
  myRole,
  terms,
  panel,
}: Readonly<{
  language: Language;
  myRole: "owner" | "editor";
  terms: EventTerms;
  panel: Panel;
}>) {
  const t = useTranslator(language);
  const { loaded } = panel;
  if (loaded === "loading") {
    return <Muted>{t("common.loading")}</Muted>;
  }
  if (loaded === "failed") {
    return (
      <>
        <Notice tone="danger" role="alert">
          {t("events.streak.failed")}
        </Notice>
        <Toolbar>
          <Button variant="quiet" onClick={() => void panel.load()}>
            {t("common.retry")}
          </Button>
        </Toolbar>
      </>
    );
  }
  const body = !loaded.settings.multiDay ? (
    <Muted>{t("events.streak.singleDay")}</Muted>
  ) : myRole === "owner" ? (
    <OwnerForm language={language} loaded={loaded} panel={panel} terms={terms} />
  ) : (
    <ReadOnly language={language} settings={loaded.settings} terms={terms} />
  );
  return (
    <>
      {body}
      {panel.saved ? (
        <Notice tone="success" role="status">
          {t("events.streak.saved")}
        </Notice>
      ) : null}
    </>
  );
}

/**
 * The event's day streak (T-405b, FR-417, FR-418, FR-1615): the owner turns it on, sets an optional daily bonus from
 * day 2, closes weekdays and upcoming dates, and saves the whole thing; an editor reads it. A single-day event says why
 * there is no streak. Days that have started can't change, so the API's refusals are said in words by reason.
 */
export function StreakPanel({ language, organizerId, eventId, myRole, terms }: Props) {
  const t = useTranslator(language);
  const panel = useStreakPanel(language, organizerId, eventId);
  return (
    <Section
      titleId="streak-title"
      title={t("events.streak.title")}
      info={<InfoTip label={t("common.info")}>{t("events.streak.intro")}</InfoTip>}
    >
      <PanelBody language={language} myRole={myRole} terms={terms} panel={panel} />
      {panel.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {panel.problem}
        </Notice>
      )}
    </Section>
  );
}
