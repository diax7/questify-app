"use client";

import {
  DEFAULT_TERMS,
  formatNumber,
  joinFieldLabel,
  joinOptionLabel,
  readEventTerms,
  termFor,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { PlayerAwards, type Caps, type QuestOption } from "#src/components/PlayerAwards.tsx";
import { useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { handleOf, nameOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Status = "pending" | "active" | "left" | "removed" | "banned" | "declined";

type Answer = Readonly<{
  fieldId: string;
  kind: string;
  label: Readonly<{ ar: string | null; en: string | null }>;
  value: string;
  /** A choice field's answer as its option's labels (T-220); an older API sends none. */
  choice?: Readonly<{ ar: string | null; en: string | null }> | null;
}>;

type Player = Readonly<{
  enrollmentId: string;
  /** Null for a deleted account (T-217). */
  username: string | null;
  status: Status;
  score: number;
  /** The join answers (FR-131); an older API sends none. */
  answers?: readonly Answer[];
  /** The oldest open flag case (T-209), linked to the Flags page. */
  openFlag?: string | null;
  /** The owner paused this player's redemptions (FR-518). */
  redeemPaused?: boolean;
  /** A rehearsal account (T-211): erased at go-live. */
  rehearsal?: boolean;
}>;

type Page = Readonly<{ players: Player[]; nextCursor: string | null }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

/**
 * Asks the owner to confirm a ban or its lift, naming the player and what happens. Escape cancels; the panel behind it
 * is inert while it is open.
 */
function BanDialog({
  language,
  player,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  player: Player;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = translatorFor(language);
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const lifting = player.status === "banned";
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ban-title"
      aria-describedby="ban-body"
      className={styles.card}
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape" && !busy) {
          cancel();
        }
      }}
    >
      <h2 id="ban-title" ref={heading} tabIndex={-1} className={styles.subtitle}>
        {t(lifting ? "players.unbanTitle" : "players.banTitle", {
          name: nameOf(player.username, language),
        })}
      </h2>
      <p id="ban-body">{t(lifting ? "players.unbanBody" : "players.banBody")}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className={styles.button} disabled={busy} onClick={confirm}>
          {t(lifting ? "players.unban" : "players.ban")}
        </button>
      </div>
    </div>
  );
}

function PlayerRow({
  language,
  currency,
  player,
  canBan,
  ask,
  askPause,
  flagsPage,
  open,
  toggle,
  children,
}: Readonly<{
  language: Language;
  /** Opens the owner's pause or resume confirmation for this player. */
  askPause: (player: Player, opener: HTMLButtonElement) => void;
  /** The event's Flags page, for the link to an open case. */
  flagsPage: string;
  /** The event's currency as a label («جواهر»). */
  currency: string;
  player: Player;
  canBan: boolean;
  ask: (player: Player, opener: HTMLButtonElement) => void;
  /** Whether the player's points record is showing. */
  open: boolean;
  toggle: () => void;
  children: ReactNode;
}>) {
  const t = translatorFor(language);
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong dir="auto">{handleOf(player.username, language)}</strong>
        <span className={styles.badge}>{t(`players.status.${player.status}`)}</span>
        {player.rehearsal === true ? (
          <span className={styles.badge}>{t("rehearsal.badge")}</span>
        ) : null}
        <span>
          {t("players.points", { currency })}: {formatNumber(player.score, language)}
        </span>
        {player.openFlag === null || player.openFlag === undefined ? null : (
          <a className={styles.textLink} href={`${flagsPage}?case=${player.openFlag}`}>
            {t("players.flagged")}
          </a>
        )}
        {player.redeemPaused === true ? (
          <span className={styles.badge}>{t("players.redeemPaused")}</span>
        ) : null}
      </p>
      {(player.answers ?? []).length === 0 ? null : (
        <dl className={styles.muted} aria-label={t("players.answers")}>
          {(player.answers ?? []).map((answer) => (
            <div key={answer.fieldId} className={styles.row}>
              <dt>{joinFieldLabel(answer, language)}:</dt>
              <dd dir="auto">
                {answer.choice === undefined || answer.choice === null
                  ? answer.value
                  : joinOptionLabel({ id: answer.value, ...answer.choice }, language)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {canBan && player.status !== "removed" ? (
        <button
          type="button"
          className={styles.quiet}
          onClick={(clicked) => ask(player, clicked.currentTarget)}
        >
          {t(player.status === "banned" ? "players.unban" : "players.ban")}
        </button>
      ) : null}
      {canBan ? (
        <button
          type="button"
          className={styles.quiet}
          onClick={(clicked) => askPause(player, clicked.currentTarget)}
        >
          {t(player.redeemPaused === true ? "flags.resume" : "flags.pause")}
        </button>
      ) : null}
      <button type="button" className={styles.quiet} aria-expanded={open} onClick={toggle}>
        {t(open ? "awards.hideRecord" : "awards.record")}
      </button>
      {open ? children : null}
    </li>
  );
}

type EventFacts = Readonly<{
  terms: EventTerms;
  timeZone: string;
  /** The quests an award may name (FR-308). */
  quests: readonly QuestOption[];
  caps: Caps | null;
}>;

/**
 * The event's words for the title and the points column (FR-941), its zone, its quests and its award caps; the
 * defaults until they arrive or if they fail.
 */
function useEventFacts(eventApi: string, language: Language): EventFacts {
  const loaded = useRef(false);
  const [facts, setFacts] = useState<EventFacts>({
    terms: DEFAULT_TERMS,
    timeZone: "Asia/Riyadh",
    quests: [],
    caps: null,
  });
  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void Promise.all([
      requestJson("GET", eventApi),
      requestJson("GET", `${eventApi}/quests`),
      requestJson("GET", `${eventApi}/awards?limit=1`),
    ]).then(([event, quests, awards]) => {
      const found = event.ok
        ? (event.body as { event?: { terms?: unknown; timezone?: string } }).event
        : undefined;
      const categories = quests.ok
        ? (quests.body as { categories: CategoryView[] }).categories
        : [];
      setFacts({
        terms: readEventTerms(found?.terms),
        timeZone: found?.timezone ?? "Asia/Riyadh",
        quests: categories.flatMap((category) =>
          category.quests.map((quest) => ({
            id: quest.id,
            title: textFor(quest.title, language),
            points: quest.points,
          })),
        ),
        caps: awards.ok ? (awards.body as { caps: Caps }).caps : null,
      });
    });
    // Once per page, also under Strict Mode's double effect.
  }, [eventApi, language]);
  return facts;
}

/** Loads the event's players page by page; the search that produced the list is kept apart from the box's text. */
function usePlayers(base: string, onFailure: (body: unknown) => void) {
  const loaded = useRef(false);
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [applied, setApplied] = useState("");

  const load = async (search: string, cursor: string | null) => {
    const params = new URLSearchParams();
    if (search !== "") {
      params.set("q", search);
    }
    if (cursor !== null) {
      params.set("cursor", cursor);
    }
    const result = await requestJson("GET", `${base}?${params.toString()}`);
    if (!result.ok) {
      onFailure(result.body);
      return;
    }
    const page = result.body as Page;
    setApplied(search);
    setPlayers((current) =>
      cursor === null ? page.players : [...(current ?? []), ...page.players],
    );
    setNext(page.nextCursor);
  };

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load("", null);
  });

  const mark = (enrollmentId: string, change: Partial<Player>) =>
    setPlayers((current) =>
      (current ?? []).map((row) =>
        row.enrollmentId === enrollmentId ? { ...row, ...change } : row,
      ),
    );

  return {
    players,
    applied,
    mark,
    search: (text: string) => void load(text, null),
    more: next === null ? null : () => void load(applied, next),
  };
}

type StandingDeps = Readonly<{
  base: string;
  language: Language;
  mark: (enrollmentId: string, change: Partial<Player>) => void;
  failed: (body: unknown) => void;
  clear: () => void;
  said: (notice: string) => void;
}>;

/**
 * The owner's two standing actions on a player, each behind a confirmation: ban or lift (FR-321) and pause or resume
 * redemption (FR-518, never automatic). Focus returns to the button that opened the sheet.
 */
function useStanding({ base, language, mark, failed, clear, said }: StandingDeps) {
  const t = translatorFor(language);
  const [asking, setAsking] = useState<Player | null>(null);
  const [pausing, setPausing] = useState<Player | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setAsking(null);
    setPausing(null);
  };
  // Back to the button that opened the dialog, once the panel is no longer inert.
  useEffect(() => {
    if (asking === null && pausing === null) {
      opener.current?.focus();
    }
  }, [asking, pausing]);

  // FR-518: the owner pauses or resumes one player's redemptions; never automatic.
  const pause = async (player: Player) => {
    const paused = player.redeemPaused !== true;
    setBusy(true);
    clear();
    const result = await requestJson("PUT", `${base}/${player.enrollmentId}/redeem-pause`, {
      paused,
    });
    setBusy(false);
    close();
    if (!result.ok) {
      failed(result.body);
      return;
    }
    mark(player.enrollmentId, { redeemPaused: paused });
    said(t(paused ? "flags.paused" : "flags.resumed", { name: nameOf(player.username, language) }));
  };

  const confirm = async (player: Player) => {
    const banned = player.status !== "banned";
    setBusy(true);
    clear();
    const result = await requestJson("PUT", `${base}/${player.enrollmentId}/ban`, { banned });
    setBusy(false);
    close();
    if (!result.ok) {
      failed(result.body);
      return;
    }
    mark(player.enrollmentId, { status: banned ? "banned" : "active" });
    said(
      t(banned ? "players.banned" : "players.unbanned", {
        name: nameOf(player.username, language),
      }),
    );
  };

  return {
    asking,
    pausing,
    busy,
    close,
    ban: () => (asking === null ? undefined : void confirm(asking)),
    pause: () => (pausing === null ? undefined : void pause(pausing)),
    askBan: (player: Player, button: HTMLButtonElement) => {
      opener.current = button;
      setAsking(player);
    },
    askPause: (player: Player, button: HTMLButtonElement) => {
      opener.current = button;
      setPausing(player);
    },
  };
}

function StandingDialogs({
  language,
  standing,
}: Readonly<{ language: Language; standing: ReturnType<typeof useStanding> }>) {
  const t = translatorFor(language);
  const { asking, pausing, busy, close } = standing;
  if (asking !== null) {
    return (
      <BanDialog
        language={language}
        player={asking}
        busy={busy}
        cancel={close}
        confirm={standing.ban}
      />
    );
  }
  if (pausing === null) {
    return null;
  }
  const resuming = pausing.redeemPaused === true;
  return (
    <ConfirmDialog
      language={language}
      title={t(resuming ? "flags.resumeTitle" : "flags.pauseTitle", {
        name: nameOf(pausing.username, language),
      })}
      body={t(resuming ? "flags.resumeBody" : "flags.pauseBody")}
      confirmLabel={t(resuming ? "flags.resume" : "flags.pause")}
      noteLabel={null}
      busy={busy}
      cancel={close}
      confirm={standing.pause}
    />
  );
}

/** The panel's last problem (an alert) and what was done (a status line). */
function Said({ problem, notice }: Readonly<{ problem: string | null; notice: string | null }>) {
  return (
    <>
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
    </>
  );
}

/**
 * The event's players for its team (T-208): what the join card discloses, page by page, with a username search. The
 * owner bans a player or lifts a ban after a confirmation; editors see the list only.
 */
export function PlayersPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = translatorFor(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const facts = useEventFacts(eventApi, language);
  const terms = facts.terms;
  const base = `${eventApi}/players`;
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const failed = (body: unknown, fallback: "players.loadFailed" | "players.saveFailed") => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(code === undefined ? t(fallback) : describeProblem(body, language, t).text);
  };
  const list = usePlayers(base, (body) => failed(body, "players.loadFailed"));
  const standing = useStanding({
    base,
    language,
    mark: list.mark,
    failed: (body) => failed(body, "players.saveFailed"),
    clear: () => setProblem(null),
    said: setNotice,
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(null);
    list.search(query.trim());
  };

  return (
    <section className={styles.panel} aria-labelledby="players-title">
      <StandingDialogs language={language} standing={standing} />
      <div className={styles.form} inert={standing.asking !== null || standing.pausing !== null}>
        <h2 id="players-title" className={styles.title}>
          {t("players.title", { players: termFor(terms.player, language) })}
        </h2>
        {myRole === "owner" ? null : <p className={styles.muted}>{t("players.ownerOnly")}</p>}
        <form className={styles.form} role="search" onSubmit={submit}>
          <label className={styles.field}>
            <span>{t("players.search")}</span>
            <input
              className={styles.input}
              type="search"
              dir="auto"
              maxLength={30}
              value={query}
              onChange={(changed) => setQuery(changed.target.value)}
            />
          </label>
        </form>
        <Said problem={problem} notice={notice} />
        {list.players === null ? <p className={styles.muted}>{t("common.loading")}</p> : null}
        {list.players !== null && list.players.length === 0 ? (
          <p className={styles.muted}>
            {t(list.applied === "" ? "players.empty" : "players.noMatch")}
          </p>
        ) : null}
        <ul className={styles.list}>
          {(list.players ?? []).map((player) => (
            <PlayerRow
              key={player.enrollmentId}
              language={language}
              currency={termFor(terms.currency, language)}
              player={player}
              canBan={myRole === "owner"}
              ask={standing.askBan}
              askPause={standing.askPause}
              flagsPage={`/${language}/organizers/${organizerId}/events/${eventId}/flags`}
              open={openId === player.enrollmentId}
              toggle={() => setOpenId(openId === player.enrollmentId ? null : player.enrollmentId)}
            >
              <PlayerAwards
                language={language}
                eventApi={eventApi}
                player={player}
                quests={facts.quests}
                timeZone={facts.timeZone}
                caps={myRole === "owner" ? null : facts.caps}
                changed={() => list.search(list.applied)}
              />
            </PlayerRow>
          ))}
        </ul>
        {list.more === null ? null : (
          <button type="button" className={styles.quiet} onClick={list.more}>
            {t("players.more")}
          </button>
        )}
      </div>
    </section>
  );
}
