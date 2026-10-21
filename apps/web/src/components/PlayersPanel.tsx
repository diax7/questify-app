"use client";

import {
  DEFAULT_TERMS,
  formatNumber,
  readEventTerms,
  termFor,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Status = "pending" | "active" | "left" | "removed" | "banned";

type Player = Readonly<{ enrollmentId: string; username: string; status: Status; score: number }>;

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
        {t(lifting ? "players.unbanTitle" : "players.banTitle", { name: player.username })}
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
}: Readonly<{
  language: Language;
  /** The event's currency as a label («جواهر»). */
  currency: string;
  player: Player;
  canBan: boolean;
  ask: (player: Player, opener: HTMLButtonElement) => void;
}>) {
  const t = translatorFor(language);
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong dir="auto">@{player.username}</strong>
        <span className={styles.badge}>{t(`players.status.${player.status}`)}</span>
        <span>
          {t("players.points", { currency })}: {formatNumber(player.score, language)}
        </span>
      </p>
      {canBan && player.status !== "removed" ? (
        <button
          type="button"
          className={styles.quiet}
          onClick={(clicked) => ask(player, clicked.currentTarget)}
        >
          {t(player.status === "banned" ? "players.unban" : "players.ban")}
        </button>
      ) : null}
    </li>
  );
}

/** The event's words for the title and the points column (FR-941); the defaults until they arrive or if they fail. */
function useEventTerms(organizerId: string, eventId: string): EventTerms {
  const loaded = useRef(false);
  const [terms, setTerms] = useState<EventTerms>(DEFAULT_TERMS);
  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}`).then((result) => {
      if (result.ok) {
        setTerms(readEventTerms((result.body as { event?: { terms?: unknown } }).event?.terms));
      }
    });
    // Once per page, also under Strict Mode's double effect.
  }, [organizerId, eventId]);
  return terms;
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

  const mark = (enrollmentId: string, status: Status) =>
    setPlayers((current) =>
      (current ?? []).map((row) => (row.enrollmentId === enrollmentId ? { ...row, status } : row)),
    );

  return {
    players,
    applied,
    mark,
    search: (text: string) => void load(text, null),
    more: next === null ? null : () => void load(applied, next),
  };
}

/**
 * The event's players for its team (T-208): what the join card discloses, page by page, with a username search. The
 * owner bans a player or lifts a ban after a confirmation; editors see the list only.
 */
export function PlayersPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = translatorFor(language);
  const terms = useEventTerms(organizerId, eventId);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/players`;
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState<Player | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
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

  const close = () => setAsking(null);
  // Back to the button that opened the dialog, once the panel is no longer inert.
  useEffect(() => {
    if (asking === null) {
      opener.current?.focus();
    }
  }, [asking]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(null);
    list.search(query.trim());
  };

  const confirm = async (player: Player) => {
    const banned = player.status !== "banned";
    setBusy(true);
    setProblem(null);
    const result = await requestJson("PUT", `${base}/${player.enrollmentId}/ban`, { banned });
    setBusy(false);
    close();
    if (!result.ok) {
      failed(result.body, "players.saveFailed");
      return;
    }
    list.mark(player.enrollmentId, banned ? "banned" : "active");
    setNotice(t(banned ? "players.banned" : "players.unbanned", { name: player.username }));
  };

  return (
    <section className={styles.panel} aria-labelledby="players-title">
      {asking === null ? null : (
        <BanDialog
          language={language}
          player={asking}
          busy={busy}
          cancel={close}
          confirm={() => void confirm(asking)}
        />
      )}
      <div className={styles.form} inert={asking !== null}>
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
              ask={(chosen, button) => {
                opener.current = button;
                setAsking(chosen);
              }}
            />
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
