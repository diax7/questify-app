"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { addonName, limitLine } from "#src/lib/activation.ts";
import {
  limitBodyOf,
  missingField,
  nameIn,
  readConsoleEvent,
  type ConsoleEvent as ConsoleEventView,
  type LimitDraft,
} from "#src/lib/console.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Input, Radio, Textarea } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Props = Readonly<{ language: Language; eventId: string }>;
type Loaded = Readonly<{ view: ConsoleEventView; available: readonly string[] }>;

/**
 * One event in the console (FR-1021, FR-1402, FR-1729): activate a draft with a limit and add-ons, reject a request
 * with a note, or change the limit and add-ons of an activated event. Nothing is charged here (FR-1020).
 */
export function ConsoleEvent({ language, eventId }: Props) {
  const t = translatorFor(language);
  const path = `/v1/admin/events/${eventId}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await requestJson("GET", path);
    const body = result.body as { event?: unknown; availableAddons?: unknown } | undefined;
    const view = result.ok ? readConsoleEvent(body?.event) : undefined;
    const available = body?.availableAddons;
    if (view === undefined || !Array.isArray(available)) {
      setProblem(describeProblem(result.body, language, translatorFor(language)).text);
      return;
    }
    setLoaded({ view, available: available.filter((item) => typeof item === "string") });
  }, [path, language]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (work: () => Promise<PostResult>, done: string) => {
    setBusy(true);
    setNotice(null);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      const missing = missingField(result.body);
      setProblem(
        missing === undefined
          ? describeProblem(result.body, language, t).text
          : t(`console.missing.${missing}`),
      );
      return;
    }
    setProblem(null);
    setNotice(done);
    await load();
  };

  if (loaded === null) {
    return problem === null ? (
      <Muted>{t("common.loading")}</Muted>
    ) : (
      <Notice tone="danger" role="alert">
        {problem}
      </Notice>
    );
  }
  const { view, available } = loaded;
  return (
    <Stack as="section" aria-labelledby="console-event-title">
      <EventFacts language={language} view={view} />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="info" role="status">
          {notice}
        </Notice>
      )}
      {view.state === "activated" ? (
        <ActivatedPanel
          language={language}
          view={view}
          available={available}
          busy={busy}
          saveLimit={(draft) =>
            void send(
              () => requestJson("PUT", `${path}/limit`, limitBodyOf(draft)),
              t("console.limitSaved"),
            )
          }
          toggle={(feature, on) =>
            void send(
              () => requestJson(on ? "PUT" : "DELETE", `${path}/addons/${feature}`),
              t("console.addonsSaved"),
            )
          }
        />
      ) : (
        <ActivateForm
          language={language}
          name={nameIn(view.event.name, language)}
          available={available}
          granted={view.addons}
          busy={busy}
          canReject={view.state === "requested"}
          activate={(draft, addons) =>
            void send(
              () =>
                requestJson(
                  "POST",
                  `${path}/activate`,
                  { limit: limitBodyOf(draft), addons },
                  { "idempotency-key": crypto.randomUUID() },
                ),
              t("console.activated"),
            )
          }
          reject={(note) =>
            void send(() => requestJson("POST", `${path}/reject`, { note }), t("console.rejected"))
          }
        />
      )}
    </Stack>
  );
}

/** Who and when: the event's name, state, join code, organizer, owner, start, and the request's time. */
function EventFacts({ language, view }: Readonly<{ language: Language; view: ConsoleEventView }>) {
  const t = translatorFor(language);
  const { event } = view;
  return (
    <>
      <TextLink href={`/${language}/console`}>{t("console.back")}</TextLink>
      <PageHeader titleId="console-event-title" title={nameIn(event.name, language)} />
      <Toolbar>
        <Badge>{t(`events.status.${event.statusNow}` as "events.status.draft")}</Badge>
        <span dir="ltr">{t("events.joinCode", { code: event.joinCode })}</span>
      </Toolbar>
      <Muted>{t("console.organizer", { name: event.organizer.name })}</Muted>
      {event.ownerEmail === null ? null : (
        <Muted>{t("console.owner", { email: event.ownerEmail })}</Muted>
      )}
      {event.startsAt === null ? null : (
        <Muted>{formatEventTime(new Date(event.startsAt), event.timezone, language)}</Muted>
      )}
      {view.state === "requested" && view.requestedAt !== null ? (
        <Notice tone="info">
          {t("console.requestedAt", {
            date: formatEventTime(new Date(view.requestedAt), event.timezone, language),
          })}
        </Notice>
      ) : null}
    </>
  );
}

/** An activated event: its limit and players, the limit form, and the add-on switches. */
function ActivatedPanel({
  language,
  view,
  available,
  busy,
  saveLimit,
  toggle,
}: Readonly<{
  language: Language;
  view: ConsoleEventView;
  available: readonly string[];
  busy: boolean;
  saveLimit: (draft: LimitDraft) => void;
  toggle: (feature: string, on: boolean) => void;
}>) {
  const t = translatorFor(language);
  const limit = limitLine(view);
  return (
    <>
      <p>{t(limit.key, limit.params)}</p>
      <Muted>{t("activation.players", { count: view.players })}</Muted>
      <LimitForm language={language} initial={view.limit} busy={busy} submit={saveLimit} />
      <AddonToggles
        language={language}
        available={available}
        chosen={view.addons}
        busy={busy}
        toggle={toggle}
      />
    </>
  );
}

function LimitFields({
  language,
  draft,
  change,
}: Readonly<{ language: Language; draft: LimitDraft; change: (draft: LimitDraft) => void }>) {
  const t = translatorFor(language);
  return (
    <FieldGroup legend={t("console.limit")} layout="choices">
      {(["hard", "soft", "none"] as const).map((mode) => (
        <Radio
          key={mode}
          name="limit-mode"
          checked={draft.mode === mode}
          onChange={() => change({ ...draft, mode })}
          label={t(`console.limit.${mode}`)}
        />
      ))}
      {draft.mode === "none" ? null : (
        <Field label={t("console.limitNumber")}>
          <Input
            dir="ltr"
            inputMode="numeric"
            value={draft.value}
            onChange={(changed) => change({ ...draft, value: changed.target.value })}
          />
        </Field>
      )}
    </FieldGroup>
  );
}

function LimitForm({
  language,
  initial,
  busy,
  submit,
}: Readonly<{
  language: Language;
  initial: ConsoleEventView["limit"];
  busy: boolean;
  submit: (draft: LimitDraft) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<LimitDraft>({
    mode: initial.mode,
    value: initial.value === null ? "" : String(initial.value),
  });
  return (
    <FieldGroup>
      <LimitFields language={language} draft={draft} change={setDraft} />
      <Button variant="primary" disabled={busy} onClick={() => submit(draft)}>
        {t("console.saveLimit")}
      </Button>
    </FieldGroup>
  );
}

function AddonToggles({
  language,
  available,
  chosen,
  busy,
  toggle,
}: Readonly<{
  language: Language;
  available: readonly string[];
  chosen: readonly string[];
  busy: boolean;
  toggle: (feature: string, on: boolean) => void;
}>) {
  const t = translatorFor(language);
  return (
    <FieldGroup legend={t("console.addons")} layout="choices">
      {available.map((feature) => (
        <Checkbox
          key={feature}
          checked={chosen.includes(feature)}
          disabled={busy}
          onChange={(changed) => toggle(feature, changed.target.checked)}
          label={addonName(feature, t)}
        />
      ))}
    </FieldGroup>
  );
}

function ActivateForm({
  language,
  name,
  available,
  granted,
  busy,
  canReject,
  activate,
  reject,
}: Readonly<{
  language: Language;
  name: string;
  available: readonly string[];
  /** Add-ons the draft already has: activation keeps exactly the ticked ones, so they start ticked. */
  granted: readonly string[];
  busy: boolean;
  canReject: boolean;
  activate: (draft: LimitDraft, addons: string[]) => void;
  reject: (note: string) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<LimitDraft>({ mode: "hard", value: "" });
  const [addons, setAddons] = useState<string[]>([...granted]);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  return (
    <FieldGroup>
      <LimitFields language={language} draft={draft} change={setDraft} />
      <FieldGroup legend={t("console.addons")} layout="choices">
        {available.map((feature) => (
          <Checkbox
            key={feature}
            checked={addons.includes(feature)}
            onChange={(changed) =>
              setAddons((current) =>
                changed.target.checked
                  ? [...current, feature]
                  : current.filter((item) => item !== feature),
              )
            }
            label={addonName(feature, t)}
          />
        ))}
      </FieldGroup>
      <Muted>{t("console.nothingCharged")}</Muted>
      {confirming ? (
        <Notice tone="warning" as="div" role="alert" labelledBy="activate-confirm">
          <p id="activate-confirm">{t("console.confirmActivate", { name })}</p>
          <Toolbar>
            <Button variant="quiet" disabled={busy} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                activate(draft, addons);
              }}
            >
              {t("console.activate")}
            </Button>
          </Toolbar>
        </Notice>
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>
          {t("console.activate")}
        </Button>
      )}
      {canReject ? (
        <>
          <Field label={t("console.note")}>
            <Textarea
              maxLength={500}
              value={note}
              onChange={(changed) => setNote(changed.target.value)}
            />
          </Field>
          <Button
            variant="quiet"
            disabled={busy || note.trim() === ""}
            onClick={() => reject(note.trim())}
          >
            {t("console.reject")}
          </Button>
        </>
      ) : null}
    </FieldGroup>
  );
}
