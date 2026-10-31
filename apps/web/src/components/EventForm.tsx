"use client";

import { readEventTerms, type EventTerms, type Language } from "@questify/shared";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  EventAccessFields,
  EventPlaceFields,
  EventIdentityFields,
  EventTimeFields,
  EventVenuePinFields,
} from "#src/components/EventFields.tsx";
import {
  BLANK_DRAFT,
  createBodyOf,
  draftOf,
  editBodyOf,
  hasUnsavedEdits,
  nameFor,
  STATUS_TONE,
  timesChanged,
  venueIsValid,
  type EventDraft,
  type EventView,
} from "#src/lib/events.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { useReportUnsaved, type ReportUnsaved } from "#src/lib/use-unsaved.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { EventWords } from "#src/components/EventWords.tsx";
import { RankingSwitch } from "#src/components/RankingSwitch.tsx";
import { EventBranding } from "#src/components/EventBranding.tsx";
import { EventFeatureSwitch } from "#src/components/EventFeatureSwitch.tsx";
import { StreakPanel } from "#src/components/StreakPanel.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { FieldGroup, Form } from "#src/ui/Field.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
const FIELDS = new Set([
  "name",
  "timezone",
  "startsAt",
  "endsAt",
  "joinMethods",
  "cityId",
  "interests",
]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  /** Absent for a new event. */
  eventId?: string;
  myRole: "owner" | "editor";
  /** Cards shown under the event's name, before its form (activation, rehearsal). */
  intro?: ReactNode;
  /** Only the details form of an existing event, for a step of the guided setup (T-605): no header, cards or switches. */
  bare?: boolean;
  /** Told when the details form holds edits it has not saved, for the guided setup to ask before it moves on. */
  onUnsaved?: ReportUnsaved;
}>;

/** Whether the details form holds edits the saved event does not have; a new event has nothing saved to compare. */
const detailsUnsaved = (draft: EventDraft | null, event: EventView | null): boolean =>
  draft !== null && event !== null && hasUnsavedEdits(draft, event);

/** The words for a refusal: the field to fix for `invalid_event`, the API's own message otherwise. */
function problemText(body: unknown, language: Language, t: Translate): string {
  const details = (body as { details?: { field?: unknown } } | undefined)?.details;
  const field = details?.field;
  if (errorCodeOf(body) === "invalid_event" && typeof field === "string" && FIELDS.has(field)) {
    return t(`events.invalid.${field}` as "events.invalid.name");
  }
  return describeProblem(body, language, t).text;
}

/**
 * One Idempotency-Key per distinct body: a retry of the same request replays the first answer, and a corrected body
 * after a refusal goes as a new request.
 */
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
 * Creates or edits an event (FR-1001–1003, FR-1608, FR-1728). Times are typed as the wall clock in the event's own
 * zone. A draft can be deleted and a live event ended by the owner, each after a confirmation naming the event.
 */
export function EventForm({
  language,
  organizerId,
  eventId,
  myRole,
  intro,
  bare,
  onUnsaved,
}: Props) {
  const t = useTranslator(language);
  const router = useRouter();
  const api = `/v1/organizers/${organizerId}/events`;
  const pages = `/${language}/organizers/${organizerId}/events`;
  const [event, setEvent] = useState<EventView | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(eventId === undefined ? BLANK_DRAFT : null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"delete" | "end" | null>(null);
  const [asking, setAsking] = useState<SaveQuestion | null>(null);
  const keyFor = useIdempotencyKey();
  const loaded = useRef(false);

  const handle = (result: PostResult): boolean => {
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return false;
    }
    if (!result.ok) {
      setProblem(problemText(result.body, language, t));
    }
    return result.ok;
  };

  const show = (view: EventView) => {
    setEvent(view);
    setDraft(draftOf(view));
  };

  useEffect(() => {
    if (eventId === undefined || loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `${api}/${eventId}`).then((result) => {
      if (handle(result)) {
        show((result.body as { event: EventView }).event);
      }
    });
    // Once per page, also under Strict Mode's double effect.
  }, [api, eventId]);

  const run = async (work: () => Promise<PostResult>): Promise<PostResult> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await work();
    setBusy(false);
    return result;
  };

  const submit = async (submitted: FormEvent<HTMLFormElement>) => {
    submitted.preventDefault();
    if (draft === null) {
      return;
    }
    if (!venueIsValid(draft)) {
      setNotice(null);
      setProblem(t("events.invalid.venuePin"));
      return;
    }
    if (event === null) {
      const body = createBodyOf(draft);
      const result = await run(() =>
        requestJson("POST", api, body, { "idempotency-key": keyFor(body) }),
      );
      if (handle(result)) {
        window.location.assign(`${pages}/${(result.body as { event: EventView }).event.id}`);
      }
      return;
    }
    // FR-1820: a change of access type is said in words and confirmed before it is saved.
    const question = saveQuestion(draft, event);
    if (question !== null) {
      setAsking(question);
      return;
    }
    await save();
  };

  /** The dialog's action: an access change that also moves the times asks about the times next, else it saves. */
  const confirmAsked = () => {
    const next =
      draft !== null && event !== null && asking === "access" && timesChanged(draft, event);
    if (next) {
      setAsking("dates");
      return;
    }
    void save();
  };

  const save = async () => {
    setAsking(null);
    if (event === null || draft === null) {
      return;
    }
    const result = await run(() =>
      requestJson("PATCH", `${api}/${event.id}`, editBodyOf(draft, draftOf(event))),
    );
    if (handle(result)) {
      show((result.body as { event: EventView }).event);
      setNotice(t("events.saved"));
    }
  };

  const confirm = async () => {
    if (event === null || confirming === null) {
      return;
    }
    const result = await run(() =>
      confirming === "delete"
        ? requestJson("DELETE", `${api}/${event.id}`)
        : requestJson("POST", `${api}/${event.id}/end`, { confirm: true }),
    );
    setConfirming(null);
    if (!handle(result)) {
      return;
    }
    if (confirming === "delete") {
      window.location.assign(pages);
      return;
    }
    setNotice(t("events.ended"));
    const fresh = await requestJson("GET", `${api}/${event.id}`);
    if (handle(fresh)) {
      show((fresh.body as { event: EventView }).event);
    }
  };

  const change = (patch: Partial<EventDraft>) =>
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  const status = event?.statusNow ?? "draft";
  const name = event === null ? "" : nameFor(event, language);
  useReportUnsaved(onUnsaved, "details", detailsUnsaved(draft, event));

  return (
    <Stack>
      <EventTop
        language={language}
        event={event}
        name={name}
        back={pages}
        intro={intro}
        bare={bare}
      />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
      {draft === null ? (
        problem === null ? (
          <Muted>{t("common.loading")}</Muted>
        ) : null
      ) : (
        <Section title={t("events.section.details")}>
          <Form onSubmit={(submitted) => void submit(submitted)}>
            <FieldGroup legend={t("events.section.identity")}>
              <EventIdentityFields
                language={language}
                draft={draft}
                disabled={busy}
                change={change}
              />
            </FieldGroup>
            <FieldGroup legend={t("events.section.place")}>
              <EventPlaceFields
                language={language}
                draft={draft}
                disabled={busy}
                change={change}
                status={status}
              />
              <EventVenuePinFields
                language={language}
                draft={draft}
                disabled={busy}
                change={change}
              />
            </FieldGroup>
            <FieldGroup legend={t("events.section.time")}>
              <EventTimeFields
                language={language}
                draft={draft}
                disabled={busy}
                change={change}
                status={status}
              />
            </FieldGroup>
            <FieldGroup legend={t("events.section.access")}>
              <EventAccessFields
                language={language}
                draft={draft}
                disabled={busy}
                change={change}
              />
            </FieldGroup>
            <Toolbar align="end">
              <Button type="submit" variant="primary" disabled={busy || asking !== null}>
                {event === null ? t("events.create") : t("events.save")}
              </Button>
            </Toolbar>
          </Form>
        </Section>
      )}
      {asking === null || draft === null ? null : (
        <SaveDialog
          language={language}
          question={asking}
          access={draft.access}
          busy={busy}
          cancel={() => setAsking(null)}
          confirm={confirmAsked}
        />
      )}
      <EventSettings
        language={language}
        organizerId={organizerId}
        event={event}
        bare={bare}
        myRole={myRole}
        confirming={confirming}
        busy={busy}
        ask={setConfirming}
        confirm={() => void confirm()}
        termsSaved={(saved) => {
          setEvent((current) => (current === null ? null : { ...current, terms: saved }));
          // The event's layout reads the words once; this reads them again for every page of the event.
          router.refresh();
        }}
      />
    </Stack>
  );
}

/** The event's header and the cards under it (activation, rehearsal); a step of the guided setup has neither. */
function EventTop({
  language,
  event,
  name,
  back,
  intro,
  bare,
}: Readonly<{
  language: Language;
  event: EventView | null;
  name: string;
  back: string;
  intro: ReactNode;
  bare: boolean | undefined;
}>) {
  const t = useTranslator(language);
  if (bare === true) {
    return null;
  }
  return (
    <>
      <PageHeader
        back={{ href: back, label: t("events.all") }}
        titleId="event-title"
        title={event === null ? t("events.new") : name}
        meta={event === null ? undefined : <EventFacts language={language} event={event} />}
      />
      {intro}
    </>
  );
}

/** What an existing event has below its details: switches, streak, words and the danger zone. */
function EventSettings({
  language,
  organizerId,
  event,
  bare,
  myRole,
  confirming,
  busy,
  ask,
  confirm,
  termsSaved,
}: Readonly<{
  language: Language;
  organizerId: string;
  event: EventView | null;
  bare: boolean | undefined;
  myRole: "owner" | "editor";
  confirming: "delete" | "end" | null;
  busy: boolean;
  ask: (what: "delete" | "end" | null) => void;
  confirm: () => void;
  termsSaved: (terms: EventTerms) => void;
}>) {
  if (event === null || bare === true) {
    return null;
  }
  const terms = readEventTerms(event.terms);
  const status = event.statusNow;
  return (
    <>
      <EventFeatures language={language} organizerId={organizerId} event={event} myRole={myRole} />
      <StreakPanel
        language={language}
        organizerId={organizerId}
        eventId={event.id}
        myRole={myRole}
        terms={terms}
      />
      <EventWords
        language={language}
        organizerId={organizerId}
        eventId={event.id}
        initial={terms}
        saved={termsSaved}
      />
      <EventDangerZone
        language={language}
        name={nameFor(event, language)}
        canDelete={status === "draft"}
        canEnd={myRole === "owner" && status === "live"}
        confirming={confirming}
        busy={busy}
        ask={ask}
        confirm={confirm}
      />
    </>
  );
}

type SaveQuestion = "access" | "dates";

/** What a save of an existing event must confirm first: a changed access type, else changed times or zone. */
function saveQuestion(draft: EventDraft, event: EventView): SaveQuestion | null {
  if (draft.access !== event.access) {
    return "access";
  }
  return timesChanged(draft, event) ? "dates" : null;
}

/** The confirmation before a save that changes who can join (FR-1820) or when the event runs (FR-1031). */
function SaveDialog({
  language,
  question,
  access,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  question: SaveQuestion;
  access: EventDraft["access"];
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  const ofAccess = question === "access";
  return (
    <Dialog
      titleId="save-confirm"
      title={
        ofAccess
          ? t("events.accessTitle", { access: t(`events.access.${access}`) })
          : t("events.dates.title")
      }
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={confirm}>
            {ofAccess ? t("events.accessConfirm") : t("events.dates.confirm")}
          </Button>
        </>
      }
    >
      {ofAccess ? (
        <>
          <p>{t(`events.accessEffect.${access}`)}</p>
          <Muted>{t("events.accessKeeps")}</Muted>
        </>
      ) : (
        <p>{t("events.dates.body")}</p>
      )}
    </Dialog>
  );
}

/** The event's status and join code under its name; a draft says Questify activates it. */
function EventFacts({ language, event }: Readonly<{ language: Language; event: EventView }>) {
  const t = useTranslator(language);
  const status = event.statusNow;
  return (
    <>
      <Badge tone={STATUS_TONE[status]}>{t(`events.status.${status}`)}</Badge>
      <span dir="ltr">{t("events.joinCode", { code: event.joinCode })}</span>
    </>
  );
}

/** The event switches the Features section lists, each with how the event read says it stands. */
export const FEATURE_SWITCHES = [
  ["shareQuests", (event: EventView) => event.shareQuests],
  ["meetSomeone", (event: EventView) => event.meetSomeone],
  ["miniGames", (event: EventView) => event.miniGames],
  ["community", (event: EventView) => event.community],
  ["flashQuests", (event: EventView) => event.flashQuests !== false],
  ["boosts", (event: EventView) => event.boosts !== false],
  ["helpDesk", (event: EventView) => event.helpDesk !== false],
  ["questRatings", (event: EventView) => event.questRatings === true],
  ["shop", (event: EventView) => event.shop !== false],
  ["polls", (event: EventView) => event.polls !== false],
  ["maps", (event: EventView) => event.maps !== false],
  ["agenda", (event: EventView) => event.agenda !== false],
] as const;

/** The event's accent colour and its on/off switches (ranking, each player feature), each saved as it changes. */
function EventFeatures({
  language,
  organizerId,
  event,
  myRole,
}: Readonly<{
  language: Language;
  organizerId: string;
  event: EventView;
  myRole: "owner" | "editor";
}>) {
  const t = useTranslator(language);
  return (
    <>
      <EventBranding
        language={language}
        organizerId={organizerId}
        eventId={event.id}
        initial={event.branding?.accent ?? null}
      />
      <Section title={t("events.section.features")}>
        <Rows as="div">
          <RankingSwitch
            language={language}
            organizerId={organizerId}
            eventId={event.id}
            initial={{ ranking: event.ranking, rankingToday: event.rankingToday }}
            myRole={myRole}
          />
          {FEATURE_SWITCHES.map(([feature, initial]) => (
            <EventFeatureSwitch
              key={feature}
              language={language}
              feature={feature}
              organizerId={organizerId}
              eventId={event.id}
              initial={initial(event)}
              myRole={myRole}
              live={event.statusNow === "live"}
            />
          ))}
        </Rows>
      </Section>
    </>
  );
}

/** Delete (a draft) and end now (the owner, a live event): each asks first and names what happens. */
function EventDangerZone({
  language,
  name,
  canDelete,
  canEnd,
  confirming,
  busy,
  ask,
  confirm,
}: Readonly<{
  language: Language;
  name: string;
  canDelete: boolean;
  canEnd: boolean;
  confirming: "delete" | "end" | null;
  busy: boolean;
  ask: (what: "delete" | "end" | null) => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  if (!canDelete && !canEnd) {
    return null;
  }
  return (
    <Section title={t("events.section.danger")} tone="danger">
      {/* The buttons step aside while their confirmation is open, so only the dialog's action carries the name. */}
      <Toolbar>
        {canDelete && confirming === null ? (
          <Button variant="danger" disabled={busy} onClick={() => ask("delete")}>
            {t("events.delete")}
          </Button>
        ) : null}
        {canEnd && confirming === null ? (
          <Button variant="danger" disabled={busy} onClick={() => ask("end")}>
            {t("events.end")}
          </Button>
        ) : null}
      </Toolbar>
      {confirming === null ? null : (
        <ConfirmEventChange
          language={language}
          name={name}
          what={confirming}
          busy={busy}
          cancel={() => ask(null)}
          confirm={confirm}
        />
      )}
    </Section>
  );
}

/** Asks before a draft is deleted or a live event ended, naming the event. */
function ConfirmEventChange({
  language,
  name,
  what,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  name: string;
  what: "delete" | "end";
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Dialog
      titleId="confirm-title"
      title={t(what === "delete" ? "events.deleteTitle" : "events.endTitle")}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={confirm}>
            {t(what === "delete" ? "events.delete" : "events.end")}
          </Button>
        </>
      }
    >
      <p>{t(what === "delete" ? "events.deleteBody" : "events.endBody", { name })}</p>
    </Dialog>
  );
}
