"use client";

import type { Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { QrImage } from "#src/components/CodesPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { nameOf } from "#src/lib/players.ts";
import {
  ABILITIES,
  PRESETS,
  abilityKey,
  inviteBody,
  presetKey,
  printable,
  withAbility,
  type InviteKind,
  type InviteView,
  type OperatorView,
  type Preset,
} from "#src/lib/operators.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import codeStyles from "#src/components/codes.module.css";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

type Station = Readonly<{ id: string; title: string }>;

type Shared = Readonly<{
  language: Language;
  busy: boolean;
  /** Runs one write; false when it failed (the panel shows why). */
  run: (method: "POST" | "PUT" | "DELETE", path: string, payload?: unknown) => Promise<boolean>;
}>;

/**
 * An event's operators (T-204, FR-901 to FR-909, FR-1720): the owner invites people by a personal QR, a batch of QRs
 * with a preset, or email; sets each operator's abilities, quest limit and may-play; removes them at once; and prints
 * the open personal codes. Editors see the list without the codes (the API gives them no claim address).
 */
export function OperatorsPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = useTranslator(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const loaded = useRef(false);
  const [operators, setOperators] = useState<OperatorView[] | null>(null);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const failed = (body: unknown) => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(
      code === undefined ? t("operators.loadFailed") : describeProblem(body, language, t).text,
    );
  };

  const load = async () => {
    const [list, quests] = await Promise.all([
      requestJson("GET", `${base}/operators?lang=${language}`),
      requestJson("GET", `${base}/quests`),
    ]);
    if (!list.ok) {
      failed(list.body);
      return;
    }
    const body = list.body as { operators: OperatorView[]; invites: InviteView[] };
    setOperators(body.operators);
    setInvites(body.invites);
    if (quests.ok) {
      const categories = (quests.body as { categories: CategoryView[] }).categories;
      setStations(
        categories.flatMap((category) =>
          category.quests
            .filter((quest) => quest.verification.includes("my_qr"))
            .map((quest) => ({ id: quest.id, title: textFor(quest.title, language) })),
        ),
      );
    }
  };

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load();
  });

  const run: Shared["run"] = async (method, path, payload) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const headers: Record<string, string> =
      method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {};
    const result = await requestJson(method, `${base}${path}`, payload, headers);
    setBusy(false);
    if (!result.ok) {
      failed(result.body);
      return false;
    }
    await load();
    return true;
  };

  const shared: Shared = { language, busy, run };
  return (
    <section className={styles.panel} aria-labelledby="operators-title">
      <h2 id="operators-title" className={styles.title}>
        {t("operators.title")}
      </h2>
      <p className={styles.muted}>{t("operators.intro")}</p>
      {myRole === "owner" ? (
        <NewInviteForm {...shared} sent={() => setNotice(t("operators.sent"))} />
      ) : (
        <p className={styles.muted}>{t("operators.ownerOnly")}</p>
      )}
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
      <h3 className={styles.subtitle}>{t("operators.listTitle")}</h3>
      {operators === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : operators.length === 0 ? (
        <p className={styles.muted}>{t("operators.none")}</p>
      ) : (
        <ul className={styles.list}>
          {operators.map((operator) => (
            <OperatorRow
              key={operator.id}
              {...shared}
              operator={operator}
              stations={stations}
              canEdit={myRole === "owner"}
            />
          ))}
        </ul>
      )}
      <InvitesList {...shared} invites={invites} canEdit={myRole === "owner"} />
      {myRole === "owner" ? <PrintSheet language={language} invites={printable(invites)} /> : null}
    </section>
  );
}

function NewInviteForm({ language, busy, run, sent }: Shared & Readonly<{ sent: () => void }>) {
  const t = useTranslator(language);
  const [kind, setKind] = useState<InviteKind>("personal");
  const [label, setLabel] = useState("");
  const [count, setCount] = useState(10);
  const [email, setEmail] = useState("");
  const [preset, setPreset] = useState<Preset>("full");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = inviteBody({ kind, label, count, email, preset }, language);
    if (await run("POST", "/operators/invites", body)) {
      setLabel("");
      setEmail("");
      if (kind === "email") {
        sent();
      }
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h3 className={styles.subtitle}>{t("operators.newTitle")}</h3>
      <label className={styles.field}>
        <span>{t("operators.kind")}</span>
        <select
          className={styles.input}
          value={kind}
          disabled={busy}
          onChange={(changed) => setKind(changed.target.value as InviteKind)}
        >
          <option value="personal">{t("operators.kind.personal")}</option>
          <option value="batch">{t("operators.kind.batch")}</option>
          <option value="email">{t("operators.kind.email")}</option>
        </select>
      </label>
      {kind === "email" ? (
        <label className={styles.field}>
          <span>{t("operators.email")}</span>
          <input
            className={styles.input}
            type="email"
            dir="ltr"
            required
            maxLength={254}
            autoComplete="off"
            value={email}
            disabled={busy}
            onChange={(changed) => setEmail(changed.target.value)}
          />
        </label>
      ) : (
        <label className={styles.field}>
          <span>{t("operators.label")}</span>
          <input
            className={styles.input}
            required
            maxLength={56}
            value={label}
            disabled={busy}
            onChange={(changed) => setLabel(changed.target.value)}
          />
          <small className={styles.muted}>{t("operators.labelHint")}</small>
        </label>
      )}
      {kind === "batch" ? (
        <label className={styles.field}>
          <span>{t("operators.count")}</span>
          <input
            className={styles.input}
            type="number"
            dir="ltr"
            min={1}
            max={100}
            required
            value={count}
            disabled={busy}
            onChange={(changed) => setCount(Number(changed.target.value))}
          />
        </label>
      ) : null}
      <label className={styles.field}>
        <span>{t("operators.preset")}</span>
        <select
          className={styles.input}
          value={preset}
          disabled={busy}
          onChange={(changed) => setPreset(changed.target.value as Preset)}
        >
          {PRESETS.map((item) => (
            <option key={item} value={item}>
              {t(presetKey(item))}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
        {t("operators.create")}
      </button>
    </form>
  );
}

function OperatorRow({
  language,
  busy,
  run,
  operator,
  stations,
  canEdit,
}: Shared & Readonly<{ operator: OperatorView; stations: readonly Station[]; canEdit: boolean }>) {
  const t = useTranslator(language);
  const [abilities, setAbilities] = useState<readonly string[]>(operator.abilities);
  const [canPlay, setCanPlay] = useState(operator.canPlay);
  const [questIds, setQuestIds] = useState<readonly string[]>(operator.questIds);
  const [confirming, setConfirming] = useState(false);
  const path = `/operators/${operator.id}`;
  const save = () => void run("PUT", path, { abilities, canPlay, questIds });

  return (
    <li className={styles.card}>
      <p>
        <bdi>{operator.username}</bdi>
        {operator.claimedVia === null ? null : (
          <span className={styles.muted}>
            {" "}
            · {t("operators.via", { label: operator.claimedVia.label })}
          </span>
        )}
      </p>
      <fieldset className={styles.field} disabled={!canEdit || busy}>
        <legend>{t("operators.abilities")}</legend>
        {ABILITIES.map((ability) => (
          <label key={ability} className={styles.check}>
            <input
              type="checkbox"
              checked={abilities.includes(ability)}
              onChange={(changed) =>
                setAbilities(withAbility(abilities, ability, changed.target.checked))
              }
            />
            <span>{t(abilityKey(ability))}</span>
          </label>
        ))}
      </fieldset>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={canPlay}
          disabled={!canEdit || busy}
          onChange={(changed) => setCanPlay(changed.target.checked)}
        />
        <span>{t("operators.canPlay")}</span>
      </label>
      <fieldset className={styles.field} disabled={!canEdit || busy}>
        <legend>{t("operators.quests")}</legend>
        {questIds.length === 0 ? <p className={styles.muted}>{t("operators.allQuests")}</p> : null}
        {stations.map((station) => (
          <label key={station.id} className={styles.check}>
            <input
              type="checkbox"
              checked={questIds.includes(station.id)}
              onChange={(changed) =>
                setQuestIds(
                  changed.target.checked
                    ? [...questIds, station.id]
                    : questIds.filter((id) => id !== station.id),
                )
              }
            />
            <span>{station.title}</span>
          </label>
        ))}
      </fieldset>
      {canEdit ? (
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={busy} onClick={save}>
            {t("operators.save")}
          </button>
          {confirming ? (
            <div
              role="alertdialog"
              aria-labelledby={`remove-${operator.id}`}
              className={styles.card}
            >
              <p id={`remove-${operator.id}`} className={styles.subtitle}>
                {t("operators.removeTitle", { name: operator.username })}
              </p>
              <p>{t("operators.removeBody")}</p>
              <p>{t("devices.removeNote")}</p>
              <button type="button" className={styles.quiet} onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => void run("DELETE", path)}
              >
                {t("operators.remove")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {t("operators.remove")}
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

function InvitesList({
  language,
  busy,
  run,
  invites,
  canEdit,
}: Shared & Readonly<{ invites: readonly InviteView[]; canEdit: boolean }>) {
  const t = useTranslator(language);
  const statusOf = (invite: InviteView) =>
    invite.status === "claimed"
      ? t("operators.status.claimed", {
          name: nameOf(invite.claimedBy?.username ?? null, language),
        })
      : t(`operators.status.${invite.status}`);
  return (
    <>
      <h3 className={styles.subtitle}>{t("operators.invitesTitle")}</h3>
      {invites.length === 0 ? <p className={styles.muted}>{t("operators.noInvites")}</p> : null}
      <ul className={styles.list}>
        {invites.map((invite) => (
          <li key={invite.id} className={styles.row}>
            <span className={styles.badge}>
              {t(invite.kind === "email" ? "operators.kind.email" : "operators.kind.personal")}
            </span>
            {invite.kind === "email" && invite.email !== null ? (
              <bdi dir="ltr">{invite.email}</bdi>
            ) : (
              <bdi>{invite.label}</bdi>
            )}
            <span className={styles.muted}>{statusOf(invite)}</span>
            {canEdit && invite.status === "open" ? (
              <button
                type="button"
                className={styles.quiet}
                disabled={busy}
                onClick={() => void run("DELETE", `/operators/invites/${invite.id}`)}
              >
                {t("operators.revoke")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** FR-902: the open personal codes, one card each, printed by the browser like the quest codes. */
function PrintSheet({
  language,
  invites,
}: Readonly<{ language: Language; invites: ReadonlyArray<InviteView & { url: string }> }>) {
  const t = useTranslator(language);
  if (invites.length === 0) {
    return null;
  }
  return (
    <>
      <div className={codeStyles.controls}>
        <p className={styles.muted}>{t("operators.printHint")}</p>
        <button type="button" className={styles.button} onClick={() => window.print()}>
          {t("operators.print")}
        </button>
      </div>
      <div className={codeStyles.sheet}>
        {invites.map((invite) => (
          <article key={invite.id} className={codeStyles.card}>
            <QrImage text={invite.url} label={t("operators.printCard", { label: invite.label })} />
            <p className={codeStyles.title}>
              <bdi>{invite.label}</bdi>
            </p>
            <p className={codeStyles.small}>{t("operators.printHint")}</p>
          </article>
        ))}
      </div>
    </>
  );
}
