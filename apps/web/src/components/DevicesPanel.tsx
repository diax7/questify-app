"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import { deviceKindKey, devicePagePath, type DeviceKind } from "#src/lib/device.ts";
import {
  devicesOf,
  kioskQuests,
  stationQuests,
  statusOf,
  type DeviceLine,
  type DeviceQuest,
  type DeviceStatus,
} from "#src/lib/devices.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
/** The list is read again this often, so last-seen and waiting devices move on their own. */
const REFRESH_MS = 15_000;

const STATUS_KEYS = {
  active: "devices.status.active",
  waiting: "devices.status.waiting",
  paused: "devices.status.paused",
  ended: "devices.status.ended",
  revoked: "devices.status.revoked",
} as const satisfies Record<DeviceStatus, string>;

type Preview = Readonly<{ code: string; kind: DeviceKind; client: string }>;

/** The device pages staff open on a screen, linked from the Devices page. */
const DEVICE_PAGES: readonly DeviceKind[] = ["station", "kiosk", "screen"];
type Confirming = Readonly<{ kind: "one"; line: DeviceLine } | { kind: "all" | "screens" }>;

/** A station's quests and a kiosk's, for the pair form. */
type QuestChoices = Readonly<{ station: readonly DeviceQuest[]; kiosk: readonly DeviceQuest[] }>;

/** The event's zone and its station and kiosk quests, for the times and the pair form. */
function useEventChoices(eventApi: string) {
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [quests, setQuests] = useState<QuestChoices>({ station: [], kiosk: [] });
  useEffect(() => {
    void Promise.all([requestJson("GET", eventApi), requestJson("GET", `${eventApi}/quests`)]).then(
      ([event, found]) => {
        const zone = event.ok
          ? (event.body as { event?: { timezone?: string } }).event?.timezone
          : undefined;
        setTimeZone(zone ?? "Asia/Riyadh");
        const list = found.ok ? (found.body as { categories: CategoryView[] }).categories : [];
        setQuests({ station: stationQuests(list), kiosk: kioskQuests(list) });
      },
    );
  }, [eventApi]);
  return { timeZone, quests };
}

/** One device: kind, label, quest, what it said it is, who paired it and when, last seen, its state; Revoke. */
function DeviceCard({
  line,
  language,
  timeZone,
  busy,
  revoke,
}: Readonly<{
  line: DeviceLine;
  language: Language;
  timeZone: string;
  busy: boolean;
  revoke: () => void;
}>) {
  const t = useTranslator(language);
  const time = (iso: string) => formatEventTime(new Date(iso), timeZone, language);
  const status = statusOf(line);
  return (
    <Card as="li">
      <Toolbar>
        <strong dir="auto">{line.label}</strong>
        <Badge>{t(deviceKindKey(line.kind))}</Badge>
        <Badge>{t(STATUS_KEYS[status])}</Badge>
      </Toolbar>
      {line.quest === null ? null : <span dir="auto">{textFor(line.quest, language)}</span>}
      {line.client === "" ? null : <Muted as="span">{line.client}</Muted>}
      {line.pairedBy?.name === null || line.pairedBy === null ? null : (
        <Muted as="span">{t("devices.pairedBy", { name: line.pairedBy.name })}</Muted>
      )}
      <Muted as="span">{t("devices.pairedAt", { time: time(line.pairedAt) })}</Muted>
      <Muted as="span">{t("devices.lastSeen", { time: time(line.lastSeenAt) })}</Muted>
      {line.scans === null ? null : (
        <Muted as="span">{t("devices.scans", { count: formatNumber(line.scans, language) })}</Muted>
      )}
      {line.status === "revoked" ? null : (
        <Toolbar>
          <Button variant="danger" size="sm" disabled={busy} onClick={revoke}>
            {t("devices.revoke")}
          </Button>
        </Toolbar>
      )}
    </Card>
  );
}

/** The second step: what the screen said it is, its quest (a station or kiosk) and its label, then Pair. */
function ConfirmFields({
  language,
  preview,
  quests,
  busy,
  back,
  confirm,
}: Readonly<{
  language: Language;
  preview: Preview;
  quests: QuestChoices;
  busy: boolean;
  back: () => void;
  confirm: (questId: string | null, label: string) => void;
}>) {
  const t = useTranslator(language);
  const [questId, setQuestId] = useState("");
  const [label, setLabel] = useState("");
  const needsQuest = preview.kind !== "screen";
  const choices = preview.kind === "kiosk" ? quests.kiosk : quests.station;
  const submit = (submitted: FormEvent) => {
    submitted.preventDefault();
    confirm(needsQuest ? questId : null, label);
  };
  return (
    <Form onSubmit={submit}>
      <Toolbar>
        <Badge>{t(deviceKindKey(preview.kind))}</Badge>
        <span>
          {preview.client === ""
            ? t("devices.clientUnknown")
            : t("devices.client", { client: preview.client })}
        </span>
      </Toolbar>
      {!needsQuest ? null : choices.length === 0 ? (
        <Muted>{t(preview.kind === "kiosk" ? "devices.noKioskQuests" : "devices.noQuests")}</Muted>
      ) : (
        <Field label={t("devices.quest")}>
          <Select value={questId} onChange={(event) => setQuestId(event.target.value)}>
            <option value="" />
            {choices.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {textFor(quest.title, language)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t("devices.label")}>
        <Input
          dir="auto"
          maxLength={40}
          placeholder={t("devices.labelHint")}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={back}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={busy || label.trim() === "" || (needsQuest && questId === "")}
        >
          {t("devices.confirm")}
        </Button>
      </Toolbar>
    </Form>
  );
}

/** The pair form: type the code, see what the screen said it is, pick its quest (a station) and name it. */
function PairForm({
  language,
  eventApi,
  quests,
  paired,
}: Readonly<{
  language: Language;
  eventApi: string;
  quests: QuestChoices;
  paired: () => void;
}>) {
  const t = useTranslator(language);
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = async (path: string, payload: object, headers: Record<string, string> = {}) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson("POST", `${eventApi}${path}`, payload, headers);
    setBusy(false);
    if (!result.ok) {
      setProblem(
        result.body === undefined
          ? t("devices.loadFailed")
          : describeProblem(result.body, language, t).text,
      );
    }
    return result;
  };
  const check = async (submitted: FormEvent) => {
    submitted.preventDefault();
    const result = await call("/devices/preview", { code });
    const body = result.body as { kind?: DeviceKind; client?: string } | undefined;
    if (result.ok && body?.kind !== undefined) {
      setPreview({ code, kind: body.kind, client: body.client ?? "" });
    }
  };
  const confirm = async (questId: string | null, label: string) => {
    if (preview === null) {
      return;
    }
    const body = { code: preview.code, kind: preview.kind, questId, label };
    const result = await call("/devices", body, { "idempotency-key": crypto.randomUUID() });
    if (result.ok) {
      setNotice(
        preview.kind === "kiosk"
          ? `${t("devices.done")} ${t("devices.kioskTip")}`
          : t("devices.done"),
      );
      setPreview(null);
      setCode("");
      paired();
    }
  };

  return (
    <Section title={t("devices.pair")} titleId="pair-device">
      <Notes problem={problem} notice={notice} loading={false} language={language} />
      {preview === null ? (
        <Form onSubmit={(event) => void check(event)}>
          <Field label={t("devices.code")}>
            <Input
              dir="ltr"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={12}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
          <Button variant="primary" type="submit" disabled={busy || code.trim() === ""}>
            {t("devices.check")}
          </Button>
        </Form>
      ) : (
        <ConfirmFields
          language={language}
          preview={preview}
          quests={quests}
          busy={busy}
          back={() => setPreview(null)}
          confirm={(questId, label) => void confirm(questId, label)}
        />
      )}
    </Section>
  );
}

/** The device list, read now and every 15 seconds; a lost session goes back to sign-in. */
function useDevices(eventApi: string, language: Language) {
  const t = useTranslator(language);
  const [devices, setDevices] = useState<readonly DeviceLine[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/devices`);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    const read = result.ok ? devicesOf(result.body) : undefined;
    if (read === undefined) {
      setProblem(t("devices.loadFailed"));
    } else {
      setDevices(read);
    }
  }, [eventApi, language, t]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { devices, problem, setProblem, load };
}

const CONFIRM_TEXT = {
  all: { title: "devices.revokeAll", body: "devices.revokeAllConfirm" },
  screens: { title: "devices.revokeScreens", body: "devices.revokeScreensConfirm" },
} as const;

/** Revoke all big screens and Revoke all, shown while devices are active. */
function RevokeAllButtons({
  language,
  active,
  busy,
  ask,
}: Readonly<{
  language: Language;
  active: readonly DeviceLine[];
  busy: boolean;
  ask: (target: Confirming) => void;
}>) {
  const t = useTranslator(language);
  if (active.length === 0) {
    return null;
  }
  return (
    <Toolbar>
      {active.some((line) => line.kind === "screen") ? (
        <Button variant="quiet" disabled={busy} onClick={() => ask({ kind: "screens" })}>
          {t("devices.revokeScreens")}
        </Button>
      ) : null}
      <Button variant="quiet" disabled={busy} onClick={() => ask({ kind: "all" })}>
        {t("devices.revokeAll")}
      </Button>
    </Toolbar>
  );
}

/** The confirmation of one revoke or of Revoke all, naming what it ends. */
function RevokeDialog({
  language,
  confirming,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  confirming: Confirming;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <ConfirmDialog
      language={language}
      title={t(confirming.kind === "one" ? "devices.revoke" : CONFIRM_TEXT[confirming.kind].title)}
      body={
        confirming.kind === "one"
          ? t("devices.revokeConfirm", { label: confirming.line.label })
          : t(CONFIRM_TEXT[confirming.kind].body)
      }
      confirmLabel={t("devices.revoke")}
      noteLabel={null}
      busy={busy}
      cancel={cancel}
      confirm={confirm}
    />
  );
}

/**
 * The event's Devices page (T-309, FR-1713): pair a station, kiosk or big screen by the code it shows, the list with
 * each device's state, Revoke, Revoke all big screens (ADR-241: the big screen's "regenerate the link") and Revoke all.
 */
export function DevicesPanel({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { timeZone, quests } = useEventChoices(eventApi);
  const { devices, problem, setProblem, load } = useDevices(eventApi, language);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);

  const revoke = async (target: Confirming) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const path = target.kind === "one" ? `/devices/${target.line.id}/revoke` : "/devices/revoke";
    const payload = target.kind === "screens" ? { kind: "screen" } : {};
    const result = await requestJson("POST", `${eventApi}${path}`, payload, {
      "idempotency-key": crypto.randomUUID(),
    });
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
    } else if (target.kind !== "one") {
      const count = (result.body as { revoked?: number } | undefined)?.revoked ?? 0;
      setNotice(t("devices.revoked", { count: formatNumber(count, language) }));
    }
    await load();
  };

  return (
    <Stack as="section" aria-labelledby="devices-title">
      <PageHeader
        titleId="devices-title"
        title={t("devices.title")}
        info={infoTip(t, "devices.intro")}
      />
      <Muted>
        {t("devices.pages")}{" "}
        {DEVICE_PAGES.map((kind, index) => (
          <span key={kind}>
            {index === 0 ? null : " · "}
            {/* A plain link, a full page load: the kiosk page's camera and wasm headers come with its own load. */}
            <a href={devicePagePath(kind, language)} dir="ltr">
              {devicePagePath(kind, language)}
            </a>
          </span>
        ))}
      </Muted>
      <PairForm
        language={language}
        eventApi={eventApi}
        quests={quests}
        paired={() => void load()}
      />
      <Notes
        problem={problem}
        notice={notice}
        loading={devices === null && problem === null}
        language={language}
      />
      {confirming === null ? null : (
        <RevokeDialog
          language={language}
          confirming={confirming}
          busy={busy}
          cancel={() => setConfirming(null)}
          confirm={() => void revoke(confirming)}
        />
      )}
      <RevokeAllButtons
        language={language}
        active={devices?.filter((line) => line.status === "active") ?? []}
        busy={busy}
        ask={setConfirming}
      />
      {devices === null ? null : devices.length === 0 ? (
        <EmptyState>{t("devices.empty")}</EmptyState>
      ) : (
        <CardList>
          {devices.map((line) => (
            <DeviceCard
              key={line.id}
              line={line}
              language={language}
              timeZone={timeZone}
              busy={busy}
              revoke={() => setConfirming({ kind: "one", line })}
            />
          ))}
        </CardList>
      )}
    </Stack>
  );
}
