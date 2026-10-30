"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { PlayerAwards } from "#src/components/PlayerAwards.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { type Translate } from "#src/lib/language.ts";
import {
  flagDetailOf,
  flagSummary,
  gameRoundText,
  locationNotes,
  methodLabel,
  resolutionKey,
  type FlagDetail,
  type FlagLine,
  type Removal,
} from "#src/lib/flags.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { FieldGroup } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { BulletList, Card, CardList, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

type Asking = "clear" | "close" | "pause" | "ban" | null;

type Shared = Readonly<{
  language: Language;
  eventApi: string;
  owner: boolean;
  timeZone: string;
  /** Reports a refused or failed call; the panel shows it. */
  failed: (body: unknown) => void;
  /** Says what was done about a case, and reloads the list with that case open. */
  done: (notice: string, flagId: string | null) => void;
}>;

const when = (iso: string | null, timeZone: string, language: Language) =>
  iso === null ? "" : formatEventTime(new Date(iso), timeZone, language);

/** A meeting's side on a case line (T-303c): "Meet (scanned)" or "Meet (shown)"; nothing for other methods. */
function MethodNote({ method, t }: Readonly<{ method: string | null; t: Translate }>) {
  const label = methodLabel(method);
  return label === null ? null : <li dir="auto">{t(label)}</li>;
}

/** What the case shows as its evidence (FR-335): the accounts on the phone, or each scan of the burst. */
function Evidence({ flag, shared }: Readonly<{ flag: FlagDetail; shared: Shared }>) {
  const t = useTranslator(shared.language);
  const at = (iso: string | null) => when(iso, shared.timeZone, shared.language);
  return (
    <>
      <SubHeading as="h4">{t("flags.evidence")}</SubHeading>
      {flag.kind === "impossible_speed" ? <Muted>{t("flags.speedNote")}</Muted> : null}
      <BulletList>
        {flag.phoneAccounts.map((account) => (
          <li key={account.enrollmentId} dir="auto">
            {t("flags.account", { name: account.username, date: at(account.lastScanAt) })}
          </li>
        ))}
        {flag.gameRounds.map((round, index) => {
          const words = gameRoundText(round, at(round.at), t);
          return (
            <li key={`${round.at ?? ""}-${String(index)}`} dir="auto">
              {words.line}
              {words.reason === null ? null : (
                <ul>
                  <li dir="auto">{words.reason}</li>
                </ul>
              )}
            </li>
          );
        })}
        {flag.burstScans.map((scan, index) => (
          <li key={`${scan.at ?? ""}-${String(index)}`} dir="auto">
            {scan.operator === null
              ? t("flags.scan", { date: at(scan.at), quest: scan.quest })
              : t("flags.scanBy", {
                  date: at(scan.at),
                  quest: scan.quest,
                  operator: scan.operator,
                })}
            <ul>
              <MethodNote method={scan.method} t={t} />
              {locationNotes(flag.kind, scan, shared.language, t).map((note) => (
                <li key={note} dir="auto">
                  {note}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </BulletList>
      {flag.waitingItems.length === 0 ? null : (
        <>
          <p>{t("flags.heldItems")}</p>
          <BulletList>
            {flag.waitingItems.map((item, index) => (
              <li key={`${item.name}-${String(index)}`} dir="auto">
                {t("flags.pickupUntil", { name: item.name, date: at(item.reservedUntil) })}
              </li>
            ))}
          </BulletList>
        </>
      )}
      {flag.paused ? <Badge tone="warning">{t("flags.pausedNote")}</Badge> : null}
      <Removals removals={flag.removals} shared={shared} />
    </>
  );
}

function Removals({
  removals,
  shared,
}: Readonly<{ removals: readonly Removal[]; shared: Shared }>) {
  const t = useTranslator(shared.language);
  if (removals.length === 0) {
    return null;
  }
  return (
    <>
      <SubHeading as="h4">{t("flags.removals")}</SubHeading>
      <BulletList>
        {removals.map((removal) => (
          <li key={removal.entryId} dir="auto">
            {t("flags.removal", {
              date: when(removal.at, shared.timeZone, shared.language),
              points: formatNumber(removal.score, shared.language),
              reason: removal.reason ?? "",
            })}
          </li>
        ))}
      </BulletList>
    </>
  );
}

/** One call from a case's confirm sheet; the answer goes to the panel. */
async function act(
  shared: Shared,
  call: Readonly<{ method: "POST" | "PUT"; path: string; payload: object }>,
  notice: string,
  flagId: string | null,
): Promise<void> {
  const result = await requestJson(call.method, `${shared.eventApi}${call.path}`, call.payload);
  if (result.ok) {
    shared.done(notice, flagId);
  } else {
    shared.failed(result.body);
  }
}

/** The sheet the case's chosen action opens; each names the player and what happens (FR-336). */
function CaseDialog({
  asking,
  flag,
  shared,
  close,
}: Readonly<{
  asking: Exclude<Asking, null>;
  flag: FlagDetail;
  shared: Shared;
  close: () => void;
}>) {
  const t = useTranslator(shared.language);
  const [busy, setBusy] = useState(false);
  const name = flag.player.username;
  const run = async (method: "POST" | "PUT", path: string, payload: object, notice: string) => {
    setBusy(true);
    await act(shared, { method, path, payload }, notice, flag.id);
    setBusy(false);
    close();
  };
  const resolve = (resolution: string, note: string) =>
    run(
      "POST",
      `/flags/${flag.id}/resolve`,
      { resolution, note: note === "" ? null : note },
      t("flags.cleared"),
    );
  const player = `/players/${flag.player.enrollmentId}`;
  const sheets = {
    clear: {
      title: t("flags.clearTitle"),
      body: t("flags.clearBody", { name }),
      label: t("flags.clear"),
      note: true,
      go: (note: string) => void resolve("cleared", note),
    },
    close: {
      title: t("flags.closeRemovedTitle"),
      body: t("flags.closeRemovedBody"),
      label: t("flags.closeRemoved"),
      note: true,
      go: (note: string) => void resolve("points_removed", note),
    },
    pause: {
      title: t(flag.paused ? "flags.resumeTitle" : "flags.pauseTitle", { name }),
      body: t(flag.paused ? "flags.resumeBody" : "flags.pauseBody"),
      label: t(flag.paused ? "flags.resume" : "flags.pause"),
      note: false,
      go: () =>
        void run(
          "PUT",
          `${player}/redeem-pause`,
          { paused: !flag.paused },
          t(flag.paused ? "flags.resumed" : "flags.paused", { name }),
        ),
    },
    ban: {
      title: t("players.banTitle", { name }),
      body: t("players.banBody"),
      label: t("players.ban"),
      note: false,
      go: () => void run("PUT", `${player}/ban`, { banned: true }, t("players.banned", { name })),
    },
  } as const;
  const sheet = sheets[asking];
  return (
    <ConfirmDialog
      language={shared.language}
      title={sheet.title}
      body={sheet.body}
      confirmLabel={sheet.label}
      noteLabel={sheet.note ? t("flags.noteLabel") : null}
      busy={busy}
      cancel={close}
      confirm={sheet.go}
    />
  );
}

/** The actions on an open case: clear, remove points then close, pause or resume and ban (the owner's two). */
function CaseActions({
  flag,
  shared,
  ask,
}: Readonly<{ flag: FlagDetail; shared: Shared; ask: (what: Asking) => void }>) {
  const t = useTranslator(shared.language);
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Toolbar>
        <Button variant="quiet" onClick={() => ask("clear")}>
          {t("flags.clear")}
        </Button>
        <Button variant="quiet" aria-expanded={removing} onClick={() => setRemoving(!removing)}>
          {t("flags.removePoints")}
        </Button>
        {shared.owner ? (
          <>
            <Button variant="quiet" onClick={() => ask("pause")}>
              {t(flag.paused ? "flags.resume" : "flags.pause")}
            </Button>
            {flag.enrollmentStatus === "banned" ? null : (
              <Button variant="quiet" onClick={() => ask("ban")}>
                {t("flags.ban")}
              </Button>
            )}
          </>
        ) : null}
      </Toolbar>
      {removing ? (
        <Card>
          <Muted>{t("flags.removeHelp")}</Muted>
          <PlayerAwards
            language={shared.language}
            eventApi={shared.eventApi}
            player={flag.player}
            quests={[]}
            timeZone={shared.timeZone}
            caps={null}
            changed={() => undefined}
          />
          <Button variant="primary" onClick={() => ask("close")}>
            {t("flags.closeRemoved")}
          </Button>
        </Card>
      ) : null}
    </>
  );
}

/** One case opened: its evidence and, while open, its actions; closed, how and by whom. */
function CaseDetail({ id, shared }: Readonly<{ id: string; shared: Shared }>) {
  const t = useTranslator(shared.language);
  const [flag, setFlag] = useState<FlagDetail | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `${shared.eventApi}/flags/${id}`).then((result) => {
      const read = result.ok ? flagDetailOf(result.body, shared.language) : undefined;
      if (read === undefined) {
        shared.failed(result.body);
      } else {
        setFlag(read);
      }
    });
  }, [id, shared]);
  if (flag === null) {
    return <Muted>{t("common.loading")}</Muted>;
  }
  return (
    <>
      {asking === null ? null : (
        <CaseDialog asking={asking} flag={flag} shared={shared} close={() => setAsking(null)} />
      )}
      <FieldGroup>
        <Evidence flag={flag} shared={shared} />
        {flag.status === "open" ? (
          <CaseActions flag={flag} shared={shared} ask={setAsking} />
        ) : (
          <p>
            {t(resolutionKey(flag.resolution))}{" "}
            {flag.resolvedBy === null
              ? null
              : t("flags.resolvedBy", {
                  name: flag.resolvedBy,
                  date: when(flag.resolvedAt, shared.timeZone, shared.language),
                })}
            {flag.note === null ? null : ` ${t("flags.note", { note: flag.note })}`}
          </p>
        )}
      </FieldGroup>
    </>
  );
}

function FlagRow({
  line,
  shared,
  start,
}: Readonly<{ line: FlagLine; shared: Shared; start: boolean }>) {
  const t = useTranslator(shared.language);
  const [open, setOpen] = useState(start);
  const summary = flagSummary(line);
  return (
    <Card as="li">
      <Toolbar>
        <strong dir="auto">@{line.player.username}</strong>
        <Badge>{t(summary.key, { count: formatNumber(summary.count, shared.language) })}</Badge>
        <Muted as="span">
          {t("flags.raised", { date: when(line.raisedAt, shared.timeZone, shared.language) })}
        </Muted>
      </Toolbar>
      {line.waiting === 0 ? null : (
        <p>{t("flags.waiting", { count: formatNumber(line.waiting, shared.language) })}</p>
      )}
      {line.resolution === null ? null : <Muted>{t(resolutionKey(line.resolution))}</Muted>}
      <Button variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t(open ? "flags.hide" : "flags.view")}
      </Button>
      {open ? <CaseDetail id={line.id} shared={shared} /> : null}
    </Card>
  );
}

/** The desk's flag hold for the event (FR-1815): the owner switches it; editors read it. */
function HoldSwitch({ hold, shared }: Readonly<{ hold: boolean; shared: Shared }>) {
  const t = useTranslator(shared.language);
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    await act(
      shared,
      { method: "PUT", path: "/flag-hold", payload: { on: !hold } },
      t("flags.holdSaved"),
      null,
    );
    setBusy(false);
  };
  return (
    <Card>
      <SubHeading>{t("flags.hold")}</SubHeading>
      <p>{t(hold ? "flags.holdOn" : "flags.holdOff")}</p>
      {shared.owner ? (
        <Button variant="quiet" disabled={busy} onClick={() => void flip()}>
          {t(hold ? "flags.holdTurnOff" : "flags.holdTurnOn")}
        </Button>
      ) : (
        <Muted>{t("flags.holdOwnerOnly")}</Muted>
      )}
    </Card>
  );
}

type Listing = Readonly<{ hold: boolean; flags: FlagLine[]; nextCursor: string | null }>;

/** The open or closed cases, page by page; `reload` starts again from the first page. */
function useFlags(eventApi: string, status: "open" | "closed", failed: (body: unknown) => void) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [round, setRound] = useState(0);
  const load = async (cursor: string | null) => {
    const params = new URLSearchParams({ status });
    if (cursor !== null) {
      params.set("cursor", cursor);
    }
    const result = await requestJson("GET", `${eventApi}/flags?${params.toString()}`);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    const page = result.body as Listing;
    setListing((current) =>
      cursor === null || current === null
        ? page
        : { ...page, flags: [...current.flags, ...page.flags] },
    );
  };
  const first = useRef(load);
  first.current = load;
  useEffect(() => {
    // A new tab or a reload round starts from the first page.
    void first.current(null);
  }, [eventApi, status, round]);
  const next = listing?.nextCursor ?? null;
  return {
    listing,
    round,
    reload: () => setRound((value) => value + 1),
    more: next === null ? null : () => void load(next),
  };
}

/**
 * The flagged-activity page (FR-335, FR-336, T-209): open and closed cases with their evidence; owners and editors
 * clear a case or close it after removing points; the owner pauses a player's redemptions, bans, and switches the
 * desk's hold. The system never acts on its own (ADR-041). A case can be opened from the Players page (`?case=`).
 */
export function FlagsPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [acted, setActed] = useState<string | null>(null);
  const [start] = useState(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("case"),
  );
  const failed = (body: unknown) => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(
      code === undefined ? t("flags.loadFailed") : describeProblem(body, language, t).text,
    );
  };
  const list = useFlags(eventApi, status, failed);
  useEffect(() => {
    void requestJson("GET", eventApi).then((result) => {
      const zone = result.ok
        ? (result.body as { event?: { timezone?: string } }).event?.timezone
        : undefined;
      if (zone !== undefined) {
        setTimeZone(zone);
      }
    });
  }, [eventApi]);
  const shared: Shared = {
    language,
    eventApi,
    owner: myRole === "owner",
    timeZone,
    failed,
    done: (said, flagId) => {
      setProblem(null);
      setNotice(said);
      setActed(flagId);
      list.reload();
    },
  };
  const flags = list.listing?.flags ?? null;
  return (
    <Stack as="section" aria-labelledby="flags-title">
      <PageHeader
        titleId="flags-title"
        title={t("flags.title")}
        info={<InfoTip label={t("common.info")}>{t("flags.intro")}</InfoTip>}
      />
      {list.listing === null ? null : <HoldSwitch hold={list.listing.hold} shared={shared} />}
      <Tabs
        label={t("flags.title")}
        items={(["open", "closed"] as const).map((tab) => ({
          key: tab,
          label: t(tab === "open" ? "flags.open" : "flags.closed"),
          current: tab === status,
          select: () => setStatus(tab),
        }))}
      />
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
      {flags === null ? <Muted>{t("common.loading")}</Muted> : null}
      {flags !== null && flags.length === 0 ? (
        <EmptyState>{t(status === "open" ? "flags.empty" : "flags.emptyClosed")}</EmptyState>
      ) : null}
      <CardList>
        {(flags ?? []).map((line) => (
          <FlagRow
            key={`${line.id}-${String(list.round)}`}
            line={line}
            shared={shared}
            start={line.id === start || line.id === acted}
          />
        ))}
      </CardList>
      {list.more === null ? null : (
        <Button variant="quiet" onClick={list.more}>
          {t("players.more")}
        </Button>
      )}
    </Stack>
  );
}
