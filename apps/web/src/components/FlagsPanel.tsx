"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { PlayerAwards } from "#src/components/PlayerAwards.tsx";
import { translatorFor } from "#src/lib/language.ts";
import {
  flagDetailOf,
  flagSummary,
  resolutionKey,
  type FlagDetail,
  type FlagLine,
  type Removal,
} from "#src/lib/flags.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

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

/** What the case shows as its evidence (FR-335): the accounts on the phone, or each scan of the burst. */
function Evidence({ flag, shared }: Readonly<{ flag: FlagDetail; shared: Shared }>) {
  const t = translatorFor(shared.language);
  const at = (iso: string | null) => when(iso, shared.timeZone, shared.language);
  return (
    <>
      <h4 className={styles.subtitle}>{t("flags.evidence")}</h4>
      <ul className={styles.muted}>
        {flag.phoneAccounts.map((account) => (
          <li key={account.enrollmentId} dir="auto">
            {t("flags.account", { name: account.username, date: at(account.lastScanAt) })}
          </li>
        ))}
        {flag.burstScans.map((scan, index) => (
          <li key={`${scan.at ?? ""}-${String(index)}`} dir="auto">
            {scan.operator === null
              ? t("flags.scan", { date: at(scan.at), quest: scan.quest })
              : t("flags.scanBy", {
                  date: at(scan.at),
                  quest: scan.quest,
                  operator: scan.operator,
                })}
          </li>
        ))}
      </ul>
      {flag.waitingItems.length === 0 ? null : (
        <>
          <p>{t("flags.heldItems")}</p>
          <ul className={styles.muted}>
            {flag.waitingItems.map((item, index) => (
              <li key={`${item.name}-${String(index)}`} dir="auto">
                {t("flags.pickupUntil", { name: item.name, date: at(item.reservedUntil) })}
              </li>
            ))}
          </ul>
        </>
      )}
      {flag.paused ? <p className={styles.badge}>{t("flags.pausedNote")}</p> : null}
      <Removals removals={flag.removals} shared={shared} />
    </>
  );
}

function Removals({
  removals,
  shared,
}: Readonly<{ removals: readonly Removal[]; shared: Shared }>) {
  const t = translatorFor(shared.language);
  if (removals.length === 0) {
    return null;
  }
  return (
    <>
      <h4 className={styles.subtitle}>{t("flags.removals")}</h4>
      <ul className={styles.muted}>
        {removals.map((removal) => (
          <li key={removal.entryId} dir="auto">
            {t("flags.removal", {
              date: when(removal.at, shared.timeZone, shared.language),
              points: formatNumber(removal.score, shared.language),
              reason: removal.reason ?? "",
            })}
          </li>
        ))}
      </ul>
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
  const t = translatorFor(shared.language);
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
  const t = translatorFor(shared.language);
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={() => ask("clear")}>
          {t("flags.clear")}
        </button>
        <button
          type="button"
          className={styles.quiet}
          aria-expanded={removing}
          onClick={() => setRemoving(!removing)}
        >
          {t("flags.removePoints")}
        </button>
        {shared.owner ? (
          <>
            <button type="button" className={styles.quiet} onClick={() => ask("pause")}>
              {t(flag.paused ? "flags.resume" : "flags.pause")}
            </button>
            {flag.enrollmentStatus === "banned" ? null : (
              <button type="button" className={styles.quiet} onClick={() => ask("ban")}>
                {t("flags.ban")}
              </button>
            )}
          </>
        ) : null}
      </div>
      {removing ? (
        <div className={styles.form}>
          <p className={styles.muted}>{t("flags.removeHelp")}</p>
          <PlayerAwards
            language={shared.language}
            eventApi={shared.eventApi}
            player={flag.player}
            quests={[]}
            timeZone={shared.timeZone}
            caps={null}
            changed={() => undefined}
          />
          <button type="button" className={styles.button} onClick={() => ask("close")}>
            {t("flags.closeRemoved")}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** One case opened: its evidence and, while open, its actions; closed, how and by whom. */
function CaseDetail({ id, shared }: Readonly<{ id: string; shared: Shared }>) {
  const t = translatorFor(shared.language);
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
    return <p className={styles.muted}>{t("common.loading")}</p>;
  }
  return (
    <div className={styles.form}>
      {asking === null ? null : (
        <CaseDialog asking={asking} flag={flag} shared={shared} close={() => setAsking(null)} />
      )}
      <div className={styles.form} inert={asking !== null}>
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
      </div>
    </div>
  );
}

function FlagRow({
  line,
  shared,
  start,
}: Readonly<{ line: FlagLine; shared: Shared; start: boolean }>) {
  const t = translatorFor(shared.language);
  const [open, setOpen] = useState(start);
  const summary = flagSummary(line);
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong dir="auto">@{line.player.username}</strong>
        <span className={styles.badge}>
          {t(summary.key, { count: formatNumber(summary.count, shared.language) })}
        </span>
        <span className={styles.muted}>
          {t("flags.raised", { date: when(line.raisedAt, shared.timeZone, shared.language) })}
        </span>
      </p>
      {line.waiting === 0 ? null : (
        <p>{t("flags.waiting", { count: formatNumber(line.waiting, shared.language) })}</p>
      )}
      {line.resolution === null ? null : (
        <p className={styles.muted}>{t(resolutionKey(line.resolution))}</p>
      )}
      <button
        type="button"
        className={styles.quiet}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t(open ? "flags.hide" : "flags.view")}
      </button>
      {open ? <CaseDetail id={line.id} shared={shared} /> : null}
    </li>
  );
}

/** The desk's flag hold for the event (FR-1815): the owner switches it; editors read it. */
function HoldSwitch({ hold, shared }: Readonly<{ hold: boolean; shared: Shared }>) {
  const t = translatorFor(shared.language);
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
    <div className={styles.card}>
      <h3 className={styles.subtitle}>{t("flags.hold")}</h3>
      <p>{t(hold ? "flags.holdOn" : "flags.holdOff")}</p>
      {shared.owner ? (
        <button type="button" className={styles.quiet} disabled={busy} onClick={() => void flip()}>
          {t(hold ? "flags.holdTurnOff" : "flags.holdTurnOn")}
        </button>
      ) : (
        <p className={styles.muted}>{t("flags.holdOwnerOnly")}</p>
      )}
    </div>
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
  const t = translatorFor(language);
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
    <section className={styles.panel} aria-labelledby="flags-title">
      <h2 id="flags-title" className={styles.title}>
        {t("flags.title")}
      </h2>
      <p className={styles.muted}>{t("flags.intro")}</p>
      {list.listing === null ? null : <HoldSwitch hold={list.listing.hold} shared={shared} />}
      <div className={styles.actions} role="group" aria-label={t("flags.title")}>
        {(["open", "closed"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={tab === status ? styles.button : styles.quiet}
            aria-pressed={tab === status}
            onClick={() => setStatus(tab)}
          >
            {t(tab === "open" ? "flags.open" : "flags.closed")}
          </button>
        ))}
      </div>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {flags === null ? <p className={styles.muted}>{t("common.loading")}</p> : null}
      {flags !== null && flags.length === 0 ? (
        <p className={styles.muted}>{t(status === "open" ? "flags.empty" : "flags.emptyClosed")}</p>
      ) : null}
      <ul className={styles.list}>
        {(flags ?? []).map((line) => (
          <FlagRow
            key={`${line.id}-${String(list.round)}`}
            line={line}
            shared={shared}
            start={line.id === start || line.id === acted}
          />
        ))}
      </ul>
      {list.more === null ? null : (
        <button type="button" className={styles.quiet} onClick={list.more}>
          {t("players.more")}
        </button>
      )}
    </section>
  );
}
