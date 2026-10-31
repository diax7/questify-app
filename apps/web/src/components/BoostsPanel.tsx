"use client";

import { formatEventTime, formatNumber, zoneLabel, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import {
  blankBoost,
  boostBodyOf,
  boostDraftOf,
  boostProblem,
  boostStateOf,
  boostsOf,
  type Boost,
  type BoostDraft,
} from "#src/lib/boosts.ts";
import { issuesOf } from "#src/lib/community.ts";
import { FLASH_MAX_MINUTES } from "#src/lib/flash.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
/** How often the list is read again while a boost is scheduled or running. */
const REFRESH_MS = 15_000;

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;
type Category = Readonly<{ id: string; name: string }>;

const STATUS_KEYS = {
  scheduled: "boosts.page.status.scheduled",
  running: "boosts.page.status.running",
  ended: "boosts.page.status.ended",
} as const;

/** The event's zone and categories, for the form. */
function useEventChoices(eventApi: string, language: Language) {
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [categories, setCategories] = useState<readonly Category[]>([]);
  useEffect(() => {
    void Promise.all([requestJson("GET", eventApi), requestJson("GET", `${eventApi}/quests`)]).then(
      ([event, found]) => {
        const zone = event.ok
          ? (event.body as { event?: { timezone?: string } }).event?.timezone
          : undefined;
        setTimeZone(zone ?? "Asia/Riyadh");
        const list = found.ok ? (found.body as { categories: CategoryView[] }).categories : [];
        setCategories(
          list.map((category) => ({ id: category.id, name: textFor(category.name, language) })),
        );
      },
    );
  }, [eventApi, language]);
  return { timeZone, categories };
}

/** The boosts, read again every 15 s while one is scheduled or running (its state and what it paid move). */
function useBoosts(eventApi: string, language: Language) {
  const t = useTranslator(language);
  const [boosts, setBoosts] = useState<readonly Boost[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const failed = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      if (code === "invalid_boost") {
        setProblem(t("boosts.page.invalid", { fields: issuesOf(body).join("، ") }));
        return;
      }
      setProblem(
        code === undefined ? t("boosts.page.loadFailed") : describeProblem(body, language, t).text,
      );
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/boosts`);
    const read = result.ok ? boostsOf(result.body) : undefined;
    if (read === undefined) {
      failed(result.body);
    } else {
      setBoosts(read);
    }
  }, [eventApi, failed]);
  useEffect(() => {
    void load();
  }, [load]);
  const active = boosts?.some((boost) => boostStateOf(boost, Date.now()) !== "ended") === true;
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);
  return { boosts, problem, setProblem, failed, load };
}

/** One boost: its category, window, state and payments; Edit and Delete while editable, Stop while it runs. */
function BoostCard({
  boost,
  language,
  timeZone,
  busy,
  edit,
  remove,
  stop,
}: Readonly<{
  boost: Boost;
  language: Language;
  timeZone: string;
  busy: boolean;
  edit: () => void;
  remove: () => void;
  stop: () => void;
}>) {
  const t = useTranslator(language);
  const at = (iso: string) => formatEventTime(new Date(iso), timeZone, language);
  const state = boostStateOf(boost, Date.now());
  return (
    <Card as="li">
      <Toolbar>
        <strong dir="auto">{textFor(boost.category, language)}</strong>
        <Badge>{t("quests.boost.badge")}</Badge>
        <Badge>{t(STATUS_KEYS[state])}</Badge>
        {boost.rehearsal ? <Badge>{t("boosts.page.rehearsal")}</Badge> : null}
      </Toolbar>
      <Muted>{t("boosts.page.window", { start: at(boost.startsAt), end: at(boost.endsAt) })}</Muted>
      <p>{t("boosts.page.paid", { count: formatNumber(boost.paid, language) })}</p>
      <Toolbar>
        {boost.editable ? (
          <>
            <Button variant="quiet" disabled={busy} onClick={edit}>
              {t("boosts.page.edit")}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={remove}>
              {t("boosts.page.delete")}
            </Button>
          </>
        ) : null}
        {state === "running" ? (
          <Button variant="primary" disabled={busy} onClick={stop}>
            {t("boosts.page.stop")}
          </Button>
        ) : null}
      </Toolbar>
    </Card>
  );
}

/** The form: the category, Start now or a start in the event's zone, and minutes. */
function BoostForm({
  language,
  timeZone,
  categories,
  draft,
  change,
  busy,
  save,
  cancel,
}: Readonly<{
  language: Language;
  timeZone: string;
  categories: readonly Category[];
  draft: BoostDraft;
  change: (draft: BoostDraft) => void;
  busy: boolean;
  save: () => void;
  cancel: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Form
      card
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Field label={t("boosts.page.category")}>
        <Select
          value={draft.categoryId}
          disabled={busy}
          onChange={(event) => change({ ...draft, categoryId: event.target.value })}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </Field>
      <Checkbox
        checked={draft.startNow}
        disabled={busy}
        onChange={(event) => change({ ...draft, startNow: event.target.checked })}
        label={t("boosts.page.startNow")}
      />
      {draft.startNow ? null : (
        <Field label={t("boosts.page.startsAt")}>
          <Input
            type="datetime-local"
            dir="ltr"
            value={draft.startsAt}
            disabled={busy}
            onChange={(event) => change({ ...draft, startsAt: event.target.value })}
          />
        </Field>
      )}
      {draft.startNow ? null : <Muted>{zoneLabel(timeZone, language)}</Muted>}
      <Field label={t("boosts.page.minutes")}>
        <Input
          type="number"
          dir="ltr"
          min={1}
          max={FLASH_MAX_MINUTES}
          value={draft.minutes}
          disabled={busy}
          onChange={(event) => change({ ...draft, minutes: Number(event.target.value) })}
        />
      </Field>
      <Muted>{t("boosts.page.rehearsalNote")}</Muted>
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("boosts.page.save")}
        </Button>
      </Toolbar>
    </Form>
  );
}

type Asking = Readonly<{ kind: "delete" | "stop"; boost: Boost }>;

/** The confirmation of Delete or Stop on one boost. */
function BoostConfirm({
  language,
  asking,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  asking: Asking;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  const label = t(asking.kind === "delete" ? "boosts.page.delete" : "boosts.page.stop");
  return (
    <ConfirmDialog
      language={language}
      title={label}
      body={textFor(asking.boost.category, language)}
      confirmLabel={label}
      noteLabel={null}
      busy={busy}
      cancel={cancel}
      confirm={confirm}
    />
  );
}

/**
 * The boost changes the manager makes: the form's draft, the Delete or Stop being asked, and the request each one sends
 * (a new Idempotency-Key per press). On success the form closes and the list is read again.
 */
function useBoostChanges({
  language,
  eventApi,
  timeZone,
  boosts,
}: Readonly<{
  language: Language;
  eventApi: string;
  timeZone: string;
  boosts: ReturnType<typeof useBoosts>;
}>) {
  const t = useTranslator(language);
  const { setProblem, failed, load } = boosts;
  const [draft, setDraft] = useState<BoostDraft | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** Sends one change; on success closes the form first, so a list already read again cannot be edited then shut. */
  const call = async (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    done: string,
  ) => {
    setBusy(true);
    const result = await requestJson(method, `${eventApi}/boosts${path}`, body, {
      "idempotency-key": crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    setProblem(null);
    setNotice(done);
    setDraft(null);
    await load();
  };
  const save = async () => {
    if (draft === null) {
      return;
    }
    const field = boostProblem(draft);
    if (field !== undefined) {
      setProblem(t("boosts.page.invalid", { fields: field }));
      return;
    }
    await call(
      draft.id === null ? "POST" : "PATCH",
      draft.id === null ? "" : `/${draft.id}`,
      boostBodyOf(draft, timeZone),
      t("boosts.page.saved"),
    );
  };
  const confirm = async () => {
    if (asking === null) {
      return;
    }
    const { kind, boost } = asking;
    setAsking(null);
    await (kind === "delete"
      ? call("DELETE", `/${boost.id}`, undefined, t("boosts.page.deleted"))
      : call("POST", `/${boost.id}/end`, {}, t("boosts.page.stopped")));
  };
  return { draft, setDraft, asking, setAsking, busy, notice, save, confirm };
}

/**
 * The event's double-point boosts without a page around them (T-307, FR-252): the list with each one's state and
 * payments, a form to add one or change a scheduled one, Delete until a minute before the start, and Stop while it runs.
 * Owners and editors. The Boosts page and the control room both draw it.
 */
export function BoostsManager({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { timeZone, categories } = useEventChoices(eventApi, language);
  const loaded = useBoosts(eventApi, language);
  const { boosts, problem } = loaded;
  const { draft, setDraft, asking, setAsking, busy, notice, save, confirm } = useBoostChanges({
    language,
    eventApi,
    timeZone,
    boosts: loaded,
  });

  return (
    <Stack>
      <Muted>{t("boosts.page.lockedNote")}</Muted>
      <Notes
        problem={problem}
        notice={notice}
        loading={boosts === null && problem === null}
        language={language}
      />
      {asking === null ? null : (
        <BoostConfirm
          language={language}
          asking={asking}
          busy={busy}
          cancel={() => setAsking(null)}
          confirm={() => void confirm()}
        />
      )}
      <>
        {boosts !== null && boosts.length === 0 ? (
          <EmptyState>{t("boosts.page.empty")}</EmptyState>
        ) : null}
        <CardList>
          {(boosts ?? []).map((boost) => (
            <BoostCard
              key={boost.id}
              boost={boost}
              language={language}
              timeZone={timeZone}
              busy={busy}
              edit={() => setDraft(boostDraftOf(boost, timeZone))}
              remove={() => setAsking({ kind: "delete", boost })}
              stop={() => setAsking({ kind: "stop", boost })}
            />
          ))}
        </CardList>
        {draft === null ? (
          <Button
            variant="primary"
            disabled={categories.length === 0}
            onClick={() => setDraft(blankBoost(categories[0]?.id ?? ""))}
          >
            {t("boosts.page.new")}
          </Button>
        ) : (
          <BoostForm
            language={language}
            timeZone={timeZone}
            categories={categories}
            draft={draft}
            change={setDraft}
            busy={busy}
            save={() => void save()}
            cancel={() => setDraft(null)}
          />
        )}
      </>
    </Stack>
  );
}

/** The Boosts page (T-307): its title and the boosts manager. */
export function BoostsPanel(props: Props) {
  const t = useTranslator(props.language);
  return (
    <Stack as="section" aria-labelledby="boosts-title">
      <PageHeader
        titleId="boosts-title"
        title={t("boosts.page.title")}
        info={infoTip(t, "boosts.page.intro")}
      />
      <BoostsManager {...props} />
    </Stack>
  );
}
