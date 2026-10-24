"use client";

import {
  formatEventTime,
  formatNumber,
  toInstant,
  toLocalInput,
  type Language,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { CommunitySettle } from "#src/components/CommunitySettle.tsx";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { handleOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import {
  flaggedNames,
  named,
  nextStep,
  prizeStatusKey,
  resultsOf,
  type Place,
  type Results,
} from "#src/lib/prizes.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  timeZone: string;
  owner: boolean;
}>;

function PlaceRow({
  place,
  language,
  flagsPage,
}: Readonly<{ place: Place; language: Language; flagsPage: string }>) {
  const t = translatorFor(language);
  const status = place.prizeStatus === null ? null : prizeStatusKey(place.prizeStatus);
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong>{t("results.place", { rank: formatNumber(place.rank, language) })}</strong>
        <span dir="auto">{handleOf(place.player.username, language)}</span>
        <span className={styles.muted}>
          {t("results.points", { points: formatNumber(place.score, language) })}
        </span>
        {place.openFlags > 0 ? (
          <span className={styles.badge}>
            {t("results.flags", { count: formatNumber(place.openFlags, language) })}
          </span>
        ) : null}
      </p>
      {place.prize === null ? null : (
        <p dir="auto">
          {t("results.prize", { prize: named(place.prize.name, language) })}
          {status === null ? null : <span className={styles.badge}> {t(status)}</span>}
        </p>
      )}
      {place.openFlags > 0 ? (
        <a className={styles.textLink} href={flagsPage}>
          {t("results.reviewFlags")}
        </a>
      ) : null}
    </li>
  );
}

/** Where the results stand, in one line. */
function StateLine({
  results,
  language,
  timeZone,
}: Readonly<{ results: Results; language: Language; timeZone: string }>) {
  const t = translatorFor(language);
  const at = (iso: string | null) =>
    iso === null ? "" : formatEventTime(new Date(iso), timeZone, language);
  switch (results.state) {
    case "not_ended":
      return <p className={styles.muted}>{t("results.notEnded")}</p>;
    case "open":
      return <p>{t("results.open")}</p>;
    case "confirmed":
      return <p>{t("results.confirmedAt", { date: at(results.confirmedAt) })}</p>;
    case "revealed":
      return (
        <p>
          {t("results.revealedAt", {
            date: at(results.revealedAt),
            deadline: at(results.claimUntil),
          })}
        </p>
      );
  }
}

/** The owner's deadline for the reveal, in the event's zone, offered from the default (ADR-162). */
function DeadlineField({
  language,
  value,
  change,
}: Readonly<{ language: Language; value: string; change: (local: string) => void }>) {
  const t = translatorFor(language);
  return (
    <label className={styles.field}>
      <span>{t("results.deadline")}</span>
      <input
        className={styles.input}
        type="datetime-local"
        dir="ltr"
        value={value}
        onChange={(e) => change(e.target.value)}
      />
      <span className={styles.muted}>{t("results.deadlineHint")}</span>
    </label>
  );
}

function useResults(eventApi: string, language: Language) {
  const t = translatorFor(language);
  const [results, setResults] = useState<Results | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const failed = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      setProblem(
        code === undefined ? t("results.loadFailed") : describeProblem(body, language, t).text,
      );
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/results`);
    const read = result.ok ? resultsOf(result.body) : undefined;
    if (read === undefined) {
      failed(result.body);
    } else {
      setResults(read);
    }
  }, [eventApi, failed]);
  useEffect(() => {
    void load();
  }, [load]);
  return { results, setResults, problem, setProblem, failed, load };
}

/** The deadline the owner picked, as an instant and in words; nothing while the field cannot be read. */
function claimOf(local: string, timeZone: string, language: Language) {
  const at = local === "" ? null : toInstant(local, timeZone);
  return at === null || Number.isNaN(at.getTime())
    ? null
    : { at, shown: formatEventTime(at, timeZone, language) };
}

/** The owner's next step with its confirm sheet: confirm the places shown, or reveal with a deadline. */
function StepControls({
  results,
  step,
  language,
  timeZone,
  send,
}: Readonly<{
  results: Results;
  step: "confirm" | "reveal";
  language: Language;
  timeZone: string;
  send: (path: string, payload: object, said: string) => Promise<void>;
}>) {
  const t = translatorFor(language);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deadline, setDeadline] = useState<string | null>(null);
  const local =
    deadline ??
    (results.defaultClaimUntil === null
      ? ""
      : toLocalInput(new Date(results.defaultClaimUntil), timeZone));
  const claim = claimOf(local, timeZone, language);
  const flagged = flaggedNames(results.places, language);
  const confirming = step === "confirm";
  const body = confirming
    ? [
        t("results.confirmBody"),
        flagged.length === 0 ? "" : t("results.confirmFlagged", { names: flagged.join("، ") }),
      ]
        .filter((line) => line !== "")
        .join(" ")
    : t("results.revealBody", { deadline: claim?.shown ?? "" });
  const go = async () => {
    setBusy(true);
    await (confirming
      ? send(
          "/results/confirm",
          { expected: results.places.map((p) => p.enrollmentId) },
          t("results.confirmed"),
        )
      : send(
          "/results/reveal",
          { claimUntil: claim?.at.toISOString() ?? "" },
          t("results.revealed"),
        ));
    setBusy(false);
    setAsking(false);
  };
  return (
    <div className={styles.form}>
      {asking ? (
        <ConfirmDialog
          language={language}
          title={t(confirming ? "results.confirmTitle" : "results.revealTitle")}
          body={body}
          confirmLabel={t(confirming ? "results.confirm" : "results.reveal")}
          noteLabel={null}
          busy={busy}
          cancel={() => setAsking(false)}
          confirm={() => void go()}
        />
      ) : null}
      {confirming ? null : <DeadlineField language={language} value={local} change={setDeadline} />}
      <button
        type="button"
        className={styles.button}
        disabled={!confirming && claim === null}
        onClick={() => setAsking(true)}
      >
        {t(confirming ? "results.confirm" : "results.reveal")}
      </button>
    </div>
  );
}

/**
 * Final results (FR-520, FR-1719, T-214): the places with their open flags and prizes. Once the event has ended the
 * owner confirms the places they see (a ban first takes a player out), which freezes them; then reveals the winners
 * with a claim deadline. Editors read only.
 */
export function ResultsPanel({ language, organizerId, eventId, timeZone, owner }: Props) {
  const t = translatorFor(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { results, setResults, problem, setProblem, failed, load } = useResults(eventApi, language);
  const [notice, setNotice] = useState<string | null>(null);
  // The confirm was refused while community rewards are still being paid (T-306b): the owner settles and pays first.
  const [paying, setPaying] = useState(false);
  if (results === null) {
    return <Notes problem={problem} notice={null} loading={problem === null} language={language} />;
  }
  const step = nextStep(results, owner);
  const send = async (path: string, payload: object, said: string) => {
    const result = await requestJson("POST", `${eventApi}${path}`, payload);
    const read = result.ok ? resultsOf(result.body) : undefined;
    if (read === undefined) {
      setPaying(errorCodeOf(result.body) === "community_paying");
      failed(result.body);
      await load();
      return;
    }
    setPaying(false);
    setProblem(null);
    setResults(read);
    setNotice(said);
  };
  const settled = (paid: boolean) => {
    setProblem(paid ? null : t("results.communityPaying"));
    setNotice(paid ? t("results.settled") : null);
    setPaying(!paid);
  };
  return (
    <section className={styles.panel} aria-labelledby="results-title">
      <h2 id="results-title" className={styles.title}>
        {t("results.title")}
      </h2>
      <StateLine results={results} language={language} timeZone={timeZone} />
      <Notes problem={problem} notice={notice} loading={false} language={language} />
      {results.places.length === 0 ? <p className={styles.muted}>{t("results.empty")}</p> : null}
      <ol className={styles.list}>
        {results.places.map((place) => (
          <PlaceRow
            key={place.enrollmentId}
            place={place}
            language={language}
            flagsPage={`/${language}/organizers/${organizerId}/events/${eventId}/flags`}
          />
        ))}
      </ol>
      {paying && owner ? (
        <CommunitySettle language={language} eventApi={eventApi} done={settled} failed={failed} />
      ) : null}
      {step === null ? null : (
        <StepControls
          key={results.state}
          results={results}
          step={step}
          language={language}
          timeZone={timeZone}
          send={send}
        />
      )}
      {owner || results.state === "revealed" ? null : (
        <p className={styles.muted}>{t("results.ownerOnly")}</p>
      )}
    </section>
  );
}
