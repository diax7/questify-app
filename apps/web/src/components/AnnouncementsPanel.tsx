"use client";

import {
  ANNOUNCEMENT_RATE,
  announcementViewSchema,
  formatNumber,
  type AnnouncementView,
  type Language,
} from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnouncementList } from "#src/components/AnnouncementParts.tsx";
import { AnnouncementComposer } from "#src/components/AnnouncementComposer.tsx";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { isTransientFailure, requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { announcementIssueKey } from "#src/lib/announcements.ts";
import type { Translate } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

export type Audience = Readonly<{ members: number; phase: string }>;
type Loaded = Readonly<{ rows: AnnouncementView[]; audience: Audience; zone: string }>;
export type AnnouncementConfirmation = Readonly<{
  path: string;
  body: unknown;
  title: string;
  text: string;
  label: string;
  success: string;
}>;

async function readAnnouncements(path: string): Promise<Loaded | undefined> {
  const [list, preview, event] = await Promise.all([
    requestJson("GET", path),
    requestJson("GET", path + "/preview"),
    requestJson("GET", path.replace(/\/announcements$/, "")),
  ]);
  if (!list.ok || !preview.ok || !event.ok) return undefined;
  const parsed = announcementViewSchema
    .array()
    .safeParse((list.body as { announcements?: unknown }).announcements);
  const audience = preview.body as Audience;
  const zone = (event.body as { event?: { timezone?: string } }).event?.timezone;
  if (!parsed.success || typeof audience.members !== "number" || typeof zone !== "string")
    return undefined;
  return { rows: parsed.data, audience, zone };
}

function useAnnouncements(path: string, language: Language) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [problem, setProblem] = useState<string>();
  const t = useTranslator(language);
  const load = useCallback(async () => {
    const read = await readAnnouncements(path);
    if (read === undefined) setProblem(t("announcements.page.loadFailed"));
    else {
      setLoaded(read);
      setProblem(undefined);
    }
  }, [path, t]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  return { loaded, problem, setProblem, load };
}

function announcementFailure(body: unknown, language: Language, t: Translate): string {
  const details = (body as { details?: { issue?: string } } | undefined)?.details;
  const issue = details?.issue;
  if (issue !== undefined && issue.startsWith("sendAt:")) return t(announcementIssueKey(issue));
  return describeProblem(body, language, t).text;
}

function useAnnouncementPress(
  language: Language,
  reload: () => Promise<void>,
  failed: (problem: string | undefined) => void,
) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const key = useRef<string | null>(null);
  const t = useTranslator(language);
  const send = async (press: AnnouncementConfirmation): Promise<boolean> => {
    key.current ??= crypto.randomUUID();
    setBusy(true);
    failed(undefined);
    const answer = await requestJson("POST", press.path, press.body, {
      "Idempotency-Key": key.current,
    });
    setBusy(false);
    const transient = isTransientFailure(answer);
    setUncertain(transient);
    if (!transient) key.current = null;
    if (!answer.ok) {
      failed(announcementFailure(answer.body, language, t));
      if (["unauthenticated", "session_expired"].includes(errorCodeOf(answer.body) ?? ""))
        window.location.assign("/" + language + "/sign-in");
      return false;
    }
    await reload();
    return true;
  };
  return { send, busy, uncertain };
}

export function AnnouncementsPanel({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const path = "/v1/organizers/" + organizerId + "/events/" + eventId + "/announcements";
  const t = useTranslator(language);
  const state = useAnnouncements(path, language);
  const press = useAnnouncementPress(language, state.load, state.setProblem);
  const [confirm, setConfirm] = useState<AnnouncementConfirmation>();
  const [notice, setNotice] = useState<string>();
  const [version, setVersion] = useState(0);
  const apply = async () => {
    if (confirm === undefined) return;
    if (await press.send(confirm)) {
      setNotice(confirm.success);
      setConfirm(undefined);
      setVersion((value) => value + 1);
    }
  };
  const cancel = (row: AnnouncementView) =>
    setConfirm({
      path: path + "/" + row.id + "/cancel",
      body: {},
      title: t("announcements.page.cancelTitle"),
      text: t("announcements.page.cancelBody"),
      label: t("announcements.page.cancel"),
      success: t("announcements.page.cancelled"),
    });
  return (
    <div className={styles.stack}>
      <h1>{t("announcements.page.title")}</h1>
      <p>{t("announcements.page.intro")}</p>
      <p>
        {t("announcements.page.limits", {
          perHour: formatNumber(ANNOUNCEMENT_RATE.perHour, language),
          perDay: formatNumber(ANNOUNCEMENT_RATE.perDay, language),
        })}
      </p>
      {state.problem === undefined ? null : <p role="alert">{state.problem}</p>}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {state.loaded === undefined ? (
        <button type="button" onClick={() => void state.load()}>
          {t("common.retry")}
        </button>
      ) : (
        <>
          <AnnouncementComposer
            key={version}
            language={language}
            path={path}
            audience={state.loaded.audience}
            zone={state.loaded.zone}
            disabled={press.busy || confirm !== undefined}
            confirm={setConfirm}
          />
          <AnnouncementList
            language={language}
            rows={state.loaded.rows}
            zone={state.loaded.zone}
            busy={press.busy || confirm !== undefined}
            cancel={cancel}
          />
        </>
      )}
      {confirm === undefined ? null : (
        <ConfirmDialog
          language={language}
          title={confirm.title}
          body={confirm.text}
          confirmLabel={confirm.label}
          noteLabel={null}
          busy={press.busy}
          cancel={() => {
            if (!press.uncertain) setConfirm(undefined);
          }}
          confirm={() => void apply()}
        />
      )}
    </div>
  );
}
