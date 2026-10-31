"use client";

import {
  ANNOUNCEMENT_RATE,
  announcementPageSchema,
  formatNumber,
  type AnnouncementView,
  type Language,
} from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnouncementList, AnnouncementPagination } from "#src/components/AnnouncementParts.tsx";
import { AnnouncementComposer } from "#src/components/AnnouncementComposer.tsx";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { PushDefaultsPanel } from "#src/components/PushDefaultsPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  useAnnouncementPress,
  type AnnouncementConfirmation,
  type Audience,
} from "#src/components/useAnnouncementPress.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Loaded = Readonly<{
  rows: AnnouncementView[];
  pending: AnnouncementView[];
  next: string | null;
  audience: Audience;
  zone: string;
}>;

async function readAnnouncements(path: string, cursor: string): Promise<Loaded | undefined> {
  const [list, pending, preview, event] = await Promise.all([
    requestJson("GET", path),
    requestJson("GET", path + "?pending=true" + cursor),
    requestJson("GET", path + "/preview"),
    requestJson("GET", path.replace(/\/announcements$/, "")),
  ]);
  if (![list, pending, preview, event].every((answer) => answer.ok)) return undefined;
  const parsed = announcementPageSchema.safeParse(list.body);
  const scheduled = announcementPageSchema.safeParse(pending.body);
  const audience = preview.body as Audience;
  const zone = (event.body as { event?: { timezone?: string } }).event?.timezone;
  if (
    !parsed.success ||
    !scheduled.success ||
    typeof audience.members !== "number" ||
    typeof zone !== "string"
  )
    return undefined;
  const next = scheduled.data.next;
  return {
    rows: parsed.data.announcements,
    pending: scheduled.data.announcements,
    audience,
    zone,
    next: next === null ? null : "&" + new URLSearchParams(next).toString(),
  };
}

function useAnnouncements(path: string, language: Language) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [problem, setProblem] = useState<string>();
  const [pages, setPages] = useState([""]);
  const [paging, setPaging] = useState(false);
  const generation = useRef(0);
  const cursor = pages.at(-1) ?? "";
  const t = useTranslator(language);
  const load = useCallback(async () => {
    const current = ++generation.current;
    const read = await readAnnouncements(path, cursor);
    if (current !== generation.current) return;
    setPaging(false);
    if (read === undefined) setProblem(t("announcements.page.loadFailed"));
    else {
      setLoaded(read);
      setProblem(undefined);
    }
  }, [path, cursor, t]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [load]);
  const page = (next: boolean) => {
    if (next && loaded?.next == null) return;
    setPaging(true);
    setPages((current) => (next ? [...current, loaded?.next ?? ""] : current.slice(0, -1)));
  };
  return { loaded, problem, setProblem, load, page, paging, hasPrevious: pages.length > 1 };
}

/** The page's title, what it may send, and the last problem and last success. */
function AnnouncementsHeader({
  language,
  problem,
  notice,
}: Readonly<{ language: Language; problem: string | undefined; notice: string | undefined }>) {
  const t = useTranslator(language);
  return (
    <>
      <PageHeader
        title={t("announcements.page.title")}
        info={infoTip(t, "announcements.page.intro")}
      />
      <Muted>
        {t("announcements.page.limits", {
          perHour: formatNumber(ANNOUNCEMENT_RATE.perHour, language),
          perDay: formatNumber(ANNOUNCEMENT_RATE.perDay, language),
        })}
      </Muted>
      {problem === undefined ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === undefined ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
    </>
  );
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
  const busy = press.busy || confirm !== undefined;
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
    <Stack>
      <AnnouncementsHeader language={language} problem={state.problem} notice={notice} />
      {state.loaded === undefined ? (
        <Button variant="primary" onClick={() => void state.load()}>
          {t("common.retry")}
        </Button>
      ) : (
        <>
          <AnnouncementComposer
            key={version}
            language={language}
            path={path}
            audience={state.loaded.audience}
            zone={state.loaded.zone}
            disabled={busy}
            confirm={setConfirm}
          />
          <PushDefaultsPanel
            language={language}
            path={path.replace(/announcements$/, "push-defaults")}
          />
          <AnnouncementList
            pending
            language={language}
            rows={state.loaded.pending}
            zone={state.loaded.zone}
            busy={busy || state.paging}
            cancel={cancel}
          />
          <AnnouncementPagination
            language={language}
            previous={state.hasPrevious}
            next={state.loaded.next !== null}
            busy={state.paging || busy}
            page={state.page}
          />
          <AnnouncementList
            language={language}
            rows={state.loaded.rows}
            zone={state.loaded.zone}
            busy={busy}
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
    </Stack>
  );
}
