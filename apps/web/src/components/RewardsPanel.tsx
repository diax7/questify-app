"use client";

import {
  DEFAULT_TERMS,
  formatNumber,
  readEventTerms,
  termFor,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import {
  REWARD_KINDS,
  SECTIONS,
  blankReward,
  createRewardBody,
  editRewardBody,
  rewardDraftOf,
  rewardProblem,
  shopProblem,
  shopRequest,
  type RewardDraft,
  type RewardField,
  type ShopField,
  type RewardView,
  type ShopSettings,
} from "#src/lib/rewards.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

type Loaded = Readonly<{ shop: ShopSettings; rewards: RewardView[] }>;

/** One labelled text box; Arabic fields read right to left, English left to right, whatever the page's language. */
function TextField({
  label,
  value,
  lang,
  multiline = false,
  invalid = false,
  change,
}: Readonly<{
  label: string;
  value: string;
  lang?: Language;
  multiline?: boolean;
  invalid?: boolean;
  change: (text: string) => void;
}>) {
  const shared = {
    className: styles.input,
    value,
    "aria-invalid": invalid,
    ...(lang === undefined ? {} : { lang, dir: directionOf(lang) }),
  };
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {multiline ? (
        <textarea {...shared} rows={3} maxLength={2000} onChange={(e) => change(e.target.value)} />
      ) : (
        <input {...shared} maxLength={120} onChange={(e) => change(e.target.value)} />
      )}
    </label>
  );
}

function NumberField({
  label,
  value,
  invalid,
  change,
}: Readonly<{
  label: string;
  value: number | string;
  invalid: boolean;
  change: (text: string) => void;
}>) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        className={styles.input}
        type="number"
        inputMode="numeric"
        dir="ltr"
        value={value}
        aria-invalid={invalid}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
}

/** The reward form, for a new reward or an edit; the kind is chosen once. */
function RewardForm({
  language,
  terms,
  initial,
  unitsOut,
  editing,
  busy,
  submit,
  cancel,
}: Readonly<{
  language: Language;
  terms: EventTerms;
  initial: RewardDraft;
  unitsOut: number;
  editing: boolean;
  busy: boolean;
  submit: (draft: RewardDraft) => void;
  cancel: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState<RewardField | undefined>(undefined);
  const set = (change: Partial<RewardDraft>) => setDraft((current) => ({ ...current, ...change }));
  const invalid = shown;
  const send = (event: FormEvent) => {
    event.preventDefault();
    const problem = rewardProblem(draft, unitsOut);
    setShown(problem);
    if (problem === undefined) {
      submit(draft);
    }
  };
  return (
    <form className={styles.card} onSubmit={send} aria-busy={busy}>
      <h3 className={styles.subtitle}>{t(editing ? "rewards.edit" : "rewards.add")}</h3>
      {editing ? null : (
        <fieldset className={styles.choices}>
          <legend>{t("rewards.kind")}</legend>
          {REWARD_KINDS.map((kind) => (
            <label key={kind} className={styles.check}>
              <input
                type="radio"
                name="reward-kind"
                checked={draft.kind === kind}
                onChange={() => set({ kind })}
              />
              <span>{t(`rewards.kind.${kind}`)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className={styles.row}>
        <TextField
          label={t("rewards.nameAr")}
          lang="ar"
          value={draft.nameAr}
          invalid={invalid === "name"}
          change={(nameAr) => set({ nameAr })}
        />
        <TextField
          label={t("rewards.nameEn")}
          lang="en"
          value={draft.nameEn}
          invalid={invalid === "name"}
          change={(nameEn) => set({ nameEn })}
        />
      </div>
      <div className={styles.row}>
        <TextField
          label={t("rewards.descriptionAr")}
          lang="ar"
          multiline
          value={draft.descriptionAr}
          change={(descriptionAr) => set({ descriptionAr })}
        />
        <TextField
          label={t("rewards.descriptionEn")}
          lang="en"
          multiline
          value={draft.descriptionEn}
          change={(descriptionEn) => set({ descriptionEn })}
        />
      </div>
      <div className={styles.row}>
        <NumberField
          label={t("rewards.price", { currency: termFor(terms.currency, language) })}
          value={draft.price}
          invalid={invalid === "price"}
          change={(text) => set({ price: Number(text) })}
        />
        <NumberField
          label={t("rewards.stock")}
          value={draft.stock}
          invalid={invalid === "stock"}
          change={(text) => set({ stock: Number(text) })}
        />
        <NumberField
          label={t("rewards.perPlayerLimit", { player: terms.player[language].one })}
          value={draft.perPlayerLimit}
          invalid={invalid === "perPlayerLimit"}
          change={(perPlayerLimit) => set({ perPlayerLimit })}
        />
      </div>
      {editing && unitsOut > 0 ? (
        <p className={styles.muted}>
          {t("rewards.stockFloor", { count: formatNumber(unitsOut, language) })}
        </p>
      ) : null}
      <div className={styles.row}>
        <label className={styles.field}>
          <span>{t("rewards.opensAt")}</span>
          <input
            className={styles.input}
            type="datetime-local"
            dir="ltr"
            value={draft.opensAt}
            onChange={(e) => set({ opensAt: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>{t("rewards.closesAt")}</span>
          <input
            className={styles.input}
            type="datetime-local"
            dir="ltr"
            value={draft.closesAt}
            aria-invalid={invalid === "closesAt"}
            onChange={(e) => set({ closesAt: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>{t("rewards.section")}</span>
          <select
            className={styles.input}
            value={draft.section}
            onChange={(e) => set({ section: e.target.value as RewardDraft["section"] })}
          >
            <option value="">{t("rewards.section.none")}</option>
            {SECTIONS.map((section) => (
              <option key={section} value={section}>
                {t(`rewards.section.${section}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.row}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.tagNew}
            onChange={(e) => set({ tagNew: e.target.checked })}
          />
          <span>{t("rewards.tag.new")}</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.tagLimited}
            onChange={(e) => set({ tagLimited: e.target.checked })}
          />
          <span>{t("rewards.tag.limited")}</span>
        </label>
      </div>
      {invalid === undefined ? null : (
        <p role="alert" className={styles.alert}>
          {t(`rewards.invalid.${invalid}`)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("rewards.save")}
        </button>
      </div>
    </form>
  );
}

/** The pickup time, the days the shop stays open after the end, and the shop's rules (ADR-048, ADR-049, FR-515). */
function ShopForm({
  language,
  initial,
  busy,
  submit,
}: Readonly<{
  language: Language;
  initial: ShopSettings;
  busy: boolean;
  submit: (shop: ShopSettings) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState<ShopField | undefined>(undefined);
  const send = (event: FormEvent) => {
    event.preventDefault();
    const problem = shopProblem(draft);
    setInvalid(problem);
    if (problem === undefined) {
      submit(draft);
    }
  };
  return (
    <form className={styles.card} onSubmit={send} aria-busy={busy}>
      <h3 className={styles.subtitle}>{t("rewards.shop")}</h3>
      <div className={styles.row}>
        <NumberField
          label={t("rewards.pickupMinutes")}
          value={draft.pickupMinutes}
          invalid={invalid === "pickupMinutes"}
          change={(text) => setDraft({ ...draft, pickupMinutes: Number(text) })}
        />
        <NumberField
          label={t("rewards.daysAfter")}
          value={draft.daysAfter}
          invalid={invalid === "daysAfter"}
          change={(text) => setDraft({ ...draft, daysAfter: Number(text) })}
        />
      </div>
      <div className={styles.row}>
        <TextField
          label={t("rewards.rulesAr")}
          lang="ar"
          multiline
          value={draft.rules.ar ?? ""}
          change={(ar) => setDraft({ ...draft, rules: { ...draft.rules, ar } })}
        />
        <TextField
          label={t("rewards.rulesEn")}
          lang="en"
          multiline
          value={draft.rules.en ?? ""}
          change={(en) => setDraft({ ...draft, rules: { ...draft.rules, en } })}
        />
      </div>
      <p className={styles.muted}>{t("rewards.rulesHint")}</p>
      {invalid === undefined ? null : (
        <p role="alert" className={styles.alert}>
          {t(`rewards.invalid.${invalid}`)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("rewards.saveShop")}
        </button>
      </div>
    </form>
  );
}

function RewardRow({
  language,
  reward,
  terms,
  busy,
  edit,
  remove,
}: Readonly<{
  language: Language;
  reward: RewardView;
  terms: EventTerms;
  busy: boolean;
  edit: () => void;
  remove: () => void;
}>) {
  const t = translatorFor(language);
  const [confirming, setConfirming] = useState(false);
  const name = reward.name[language] ?? reward.name[language === "ar" ? "en" : "ar"] ?? "";
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong>{name}</strong>
        <span className={styles.badge}>{t(`rewards.kind.${reward.kind}`)}</span>
        <span>
          {t("rewards.priceShort", {
            points: formatNumber(reward.price, language),
            currency: termFor(terms.currency, language),
          })}
        </span>
        <span>
          {reward.stockLeft === 0
            ? t("rewards.soldOut")
            : t("rewards.left", {
                left: formatNumber(reward.stockLeft, language),
                stock: formatNumber(reward.stock, language),
              })}
        </span>
        {reward.unitsOut > 0 ? (
          <span className={styles.muted}>
            {t("rewards.reserved", { count: formatNumber(reward.unitsOut, language) })}
          </span>
        ) : null}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={edit}>
          {t("rewards.edit")}
        </button>
        {confirming ? (
          <>
            <span role="alert">{t("rewards.removeConfirm")}</span>
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </button>
            <button type="button" className={styles.button} disabled={busy} onClick={remove}>
              {t("rewards.remove")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("rewards.remove")}
          </button>
        )}
      </div>
    </li>
  );
}

type Editing =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "edit"; reward: RewardView }>
  | undefined;

/**
 * An event's rewards shop on the dashboard (T-201: FR-504, FR-505, FR-514, FR-516): the rewards with their stock, a
 * form to add or change one, removal with a confirmation, and the shop settings. Every answer refreshes the list.
 */
export function RewardsPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  // Until the event arrives its zone is unknown: adding or editing waits, so no time is read in the wrong zone.
  const [event, setEvent] = useState<{ timezone: string; terms: EventTerms } | undefined>(
    undefined,
  );
  const terms = event?.terms ?? DEFAULT_TERMS;
  const [editing, setEditing] = useState<Editing>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  const failed = useCallback(
    (result: PostResult): boolean => {
      if (result.ok) {
        return false;
      }
      if (SESSION_LOST.has(errorCodeOf(result.body) ?? "")) {
        window.location.assign(`/${language}/sign-in`);
        return true;
      }
      setProblem(describeProblem(result.body, language, t).text);
      return true;
    },
    [language, t],
  );

  const load = useCallback(async () => {
    const result = await requestJson("GET", `${base}/rewards`);
    if (!failed(result)) {
      setLoaded(result.body as Loaded);
    }
  }, [base, failed]);

  useEffect(() => {
    // Once per page, also under Strict Mode's double effect.
    if (started.current) {
      return;
    }
    started.current = true;
    void load();
    void requestJson("GET", base).then((result) => {
      if (result.ok) {
        const view = (result.body as { event: { timezone: string; terms?: unknown } }).event;
        setEvent({ timezone: view.timezone, terms: readEventTerms(view.terms) });
      }
    });
  }, [base, load]);

  const run = async (work: () => Promise<PostResult>, done: MessageKey) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await work();
    if (!failed(result)) {
      setEditing(undefined);
      setNotice(t(done));
      await load();
    }
    setBusy(false);
  };

  const save = (draft: RewardDraft) =>
    editing?.kind === "edit"
      ? run(
          () =>
            requestJson(
              "PATCH",
              `${base}/rewards/${editing.reward.id}`,
              editRewardBody(
                draft,
                rewardDraftOf(editing.reward, event?.timezone ?? "Asia/Riyadh"),
              ),
            ),
          "rewards.saved",
        )
      : run(
          () =>
            requestJson("POST", `${base}/rewards`, createRewardBody(draft), {
              "idempotency-key": crypto.randomUUID(),
            }),
          "rewards.saved",
        );

  return (
    <section className={styles.panel} aria-labelledby="rewards-title">
      <h2 id="rewards-title" className={styles.title}>
        {t("rewards.title")}
      </h2>
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
      {loaded === undefined && problem !== null ? (
        <button type="button" className={styles.quiet} onClick={() => void load()}>
          {t("common.retry")}
        </button>
      ) : null}
      {loaded === undefined ? (
        problem === null ? (
          <p className={styles.muted}>{t("common.loading")}</p>
        ) : null
      ) : (
        <>
          {editing === undefined ? (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                disabled={event === undefined}
                onClick={() => setEditing({ kind: "new" })}
              >
                {t("rewards.add")}
              </button>
            </div>
          ) : (
            <RewardForm
              key={editing.kind === "edit" ? editing.reward.id : "new"}
              language={language}
              terms={terms}
              initial={
                editing.kind === "edit"
                  ? rewardDraftOf(editing.reward, event?.timezone ?? "Asia/Riyadh")
                  : blankReward()
              }
              unitsOut={editing.kind === "edit" ? editing.reward.unitsOut : 0}
              editing={editing.kind === "edit"}
              busy={busy}
              submit={(draft) => void save(draft)}
              cancel={() => setEditing(undefined)}
            />
          )}
          {loaded.rewards.length === 0 ? <p className={styles.muted}>{t("rewards.none")}</p> : null}
          <ul className={styles.list}>
            {loaded.rewards.map((reward) => (
              <RewardRow
                key={reward.id}
                language={language}
                reward={reward}
                terms={terms}
                busy={busy || event === undefined}
                edit={() => setEditing({ kind: "edit", reward })}
                remove={() =>
                  void run(
                    () => requestJson("DELETE", `${base}/rewards/${reward.id}`),
                    "rewards.removed",
                  )
                }
              />
            ))}
          </ul>
          <ShopForm
            language={language}
            initial={loaded.shop}
            busy={busy}
            submit={(shop) =>
              void run(
                () => requestJson("PUT", `${base}/shop`, shopRequest(shop)),
                "rewards.shopSaved",
              )
            }
          />
        </>
      )}
    </section>
  );
}
