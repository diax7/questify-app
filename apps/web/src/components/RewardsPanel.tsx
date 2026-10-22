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
  DESK_WINDOWS,
  HANDOVER_CONFIRM,
  REWARD_KINDS,
  SECTIONS,
  blankReward,
  createRewardBody,
  deskDraftOf,
  deskIsSet,
  deskProblem,
  deskRequest,
  editRewardBody,
  firstColumn,
  lowCodeRewards,
  nextWindow,
  parseCodes,
  rewardDraftOf,
  rewardProblem,
  shopProblem,
  shopRequest,
  type CodesProblem,
  type DeskDraft,
  type DeskField,
  type RewardDraft,
  type RewardField,
  type ShopField,
  type RewardView,
  type ShopSettings,
} from "#src/lib/rewards.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  role: "owner" | "editor";
}>;

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
  deskSet,
  busy,
  submit,
  cancel,
}: Readonly<{
  language: Language;
  terms: EventTerms;
  initial: RewardDraft;
  unitsOut: number;
  editing: boolean;
  /** Item rewards need the prize desk's place first (FR-1716). */
  deskSet: boolean;
  busy: boolean;
  submit: (draft: RewardDraft) => void;
  cancel: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState<RewardField | undefined>(undefined);
  const set = (change: Partial<RewardDraft>) => setDraft((current) => ({ ...current, ...change }));
  const invalid = shown;
  const needsDesk = !editing && draft.kind === "item" && !deskSet;
  const send = (event: FormEvent) => {
    event.preventDefault();
    const problem = rewardProblem(draft, unitsOut);
    setShown(problem);
    if (problem === undefined) {
      submit(draft);
    }
  };
  return (
    <form className={styles.formCard} onSubmit={send} aria-busy={busy}>
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
        {draft.kind === "digital" ? null : (
          <NumberField
            label={t("rewards.stock")}
            value={draft.stock}
            invalid={invalid === "stock"}
            change={(text) => set({ stock: Number(text) })}
          />
        )}
        <NumberField
          label={t("rewards.perPlayerLimit", { player: terms.player[language].one })}
          value={draft.perPlayerLimit}
          invalid={invalid === "perPlayerLimit"}
          change={(perPlayerLimit) => set({ perPlayerLimit })}
        />
      </div>
      {draft.kind === "digital" ? (
        <p className={styles.muted}>{t("rewards.stockFromCodes")}</p>
      ) : null}
      {editing && unitsOut > 0 && draft.kind !== "digital" ? (
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
      {needsDesk ? (
        <p role="alert" className={styles.alert}>
          {t("rewards.desk.needed")}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy || needsDesk}>
          {t("rewards.save")}
        </button>
      </div>
    </form>
  );
}

const CONFIRM_TEXT: Readonly<Record<(typeof HANDOVER_CONFIRM)[number], MessageKey>> = {
  collect_first: "rewards.desk.confirm.collectFirst",
  desk_offer: "rewards.desk.confirm.deskOffer",
};

/**
 * The event's one prize desk (FR-1716, ADR-150): its place, an optional map pin, optional opening hours as windows in
 * the event's zone (off: open the whole time), and how players confirm a pickup in their own app (ADR-137).
 */
function DeskForm({
  language,
  initial,
  busy,
  submit,
}: Readonly<{
  language: Language;
  initial: DeskDraft;
  busy: boolean;
  submit: (desk: DeskDraft) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState<DeskField | undefined>(undefined);
  const set = (change: Partial<DeskDraft>) => setDraft((current) => ({ ...current, ...change }));
  const setWindow = (index: number, change: Partial<DeskDraft["windows"][number]>) =>
    set({ windows: draft.windows.map((w, i) => (i === index ? { ...w, ...change } : w)) });
  const send = (event: FormEvent) => {
    event.preventDefault();
    const problem = deskProblem(draft);
    setInvalid(problem);
    if (problem === undefined) {
      submit(draft);
    }
  };
  const placeSet = draft.locationAr.trim() !== "" || draft.locationEn.trim() !== "";
  return (
    <form className={styles.formCard} onSubmit={send} aria-busy={busy}>
      <h3 className={styles.subtitle}>{t("rewards.desk.title")}</h3>
      {placeSet ? null : <p className={styles.muted}>{t("rewards.desk.needed")}</p>}
      <div className={styles.row}>
        <TextField
          label={t("rewards.desk.locationAr")}
          lang="ar"
          value={draft.locationAr}
          change={(locationAr) => set({ locationAr })}
        />
        <TextField
          label={t("rewards.desk.locationEn")}
          lang="en"
          value={draft.locationEn}
          change={(locationEn) => set({ locationEn })}
        />
      </div>
      <div className={styles.row}>
        <NumberField
          label={t("rewards.desk.lat")}
          value={draft.lat}
          invalid={invalid === "deskPin"}
          change={(lat) => set({ lat })}
        />
        <NumberField
          label={t("rewards.desk.lng")}
          value={draft.lng}
          invalid={invalid === "deskPin"}
          change={(lng) => set({ lng })}
        />
      </div>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.hoursOn}
          onChange={(e) =>
            set({
              hoursOn: e.target.checked,
              windows:
                e.target.checked && draft.windows.length === 0 ? [nextWindow([])] : draft.windows,
            })
          }
        />
        <span>{t("rewards.desk.hoursOn")}</span>
      </label>
      {draft.hoursOn ? (
        <>
          <p className={styles.muted}>{t("rewards.desk.hoursHint")}</p>
          {draft.windows.map((window, index) => (
            <div key={index} className={styles.row}>
              <label className={styles.field}>
                <span>{t("rewards.desk.opens")}</span>
                <input
                  className={styles.input}
                  type="datetime-local"
                  dir="ltr"
                  value={window.opensAt}
                  aria-invalid={invalid === "deskHours"}
                  onChange={(e) => setWindow(index, { opensAt: e.target.value })}
                />
              </label>
              <label className={styles.field}>
                <span>{t("rewards.desk.closes")}</span>
                <input
                  className={styles.input}
                  type="datetime-local"
                  dir="ltr"
                  value={window.closesAt}
                  aria-invalid={invalid === "deskHours"}
                  onChange={(e) => setWindow(index, { closesAt: e.target.value })}
                />
              </label>
              <button
                type="button"
                className={styles.quiet}
                onClick={() => set({ windows: draft.windows.filter((_, i) => i !== index) })}
              >
                {t("rewards.desk.removeWindow")}
              </button>
            </div>
          ))}
          {draft.windows.length < DESK_WINDOWS ? (
            <button
              type="button"
              className={styles.quiet}
              onClick={() => set({ windows: [...draft.windows, nextWindow(draft.windows)] })}
            >
              {t("rewards.desk.addWindow")}
            </button>
          ) : null}
        </>
      ) : (
        <p className={styles.muted}>{t("rewards.desk.alwaysOpen")}</p>
      )}
      <fieldset className={styles.choices}>
        <legend>{t("rewards.desk.confirm")}</legend>
        {HANDOVER_CONFIRM.map((confirm) => (
          <label key={confirm} className={styles.check}>
            <input
              type="radio"
              name="handover-confirm"
              checked={draft.confirm === confirm}
              onChange={() => set({ confirm })}
            />
            <span>{t(CONFIRM_TEXT[confirm])}</span>
          </label>
        ))}
      </fieldset>
      {invalid === undefined ? null : (
        <p role="alert" className={styles.alert}>
          {t(`rewards.invalid.${invalid}`)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("rewards.desk.save")}
        </button>
      </div>
    </form>
  );
}

/** The pickup time, the days the shop stays open after the end, and the shop's rules (ADR-048, ADR-049, FR-515). */
function ShopForm({
  language,
  initial,
  rankLock,
  busy,
  submit,
}: Readonly<{
  language: Language;
  initial: ShopSettings;
  /** Why the ranking choice cannot change here, if it cannot (FR-1847). */
  rankLock: "locked" | "ownerOnly" | undefined;
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
    <form className={styles.formCard} onSubmit={send} aria-busy={busy}>
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
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.spendLowersRank}
          disabled={rankLock !== undefined}
          aria-describedby="spend-rank-hint"
          onChange={(e) => setDraft({ ...draft, spendLowersRank: e.target.checked })}
        />
        <span>{t("rewards.spendLowersRank")}</span>
      </label>
      <p id="spend-rank-hint" className={styles.muted}>
        {t("rewards.spendLowersRank.hint")}
        {rankLock === undefined ? null : ` ${t(`rewards.spendLowersRank.${rankLock}`)}`}
      </p>
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
  upload,
}: Readonly<{
  language: Language;
  reward: RewardView;
  terms: EventTerms;
  busy: boolean;
  edit: () => void;
  remove: () => void;
  upload: (codes: string[]) => Promise<boolean>;
}>) {
  const t = translatorFor(language);
  const [confirming, setConfirming] = useState(false);
  const name = reward.name[language] ?? reward.name[language === "ar" ? "en" : "ar"] ?? "";
  return (
    <li className={`${styles.card} ${styles.wrap}`}>
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
            {t(reward.kind === "digital" ? "rewards.redeemed" : "rewards.reserved", {
              count: formatNumber(reward.unitsOut, language),
            })}
          </span>
        ) : null}
      </p>
      {reward.kind === "digital" ? (
        <CodesForm language={language} busy={busy} upload={upload} />
      ) : null}
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

/** Adds a digital reward's codes (FR-510): pasted, one per line, or read from a text or CSV file in the browser. */
function CodesForm({
  language,
  busy,
  upload,
}: Readonly<{ language: Language; busy: boolean; upload: (codes: string[]) => Promise<boolean> }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState<CodesProblem | undefined>(undefined);
  if (!open) {
    return (
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          {t("rewards.codes.add")}
        </button>
      </div>
    );
  }
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseCodes(text);
    if ("problem" in parsed) {
      setInvalid(parsed.problem);
      return;
    }
    setInvalid(undefined);
    if (await upload(parsed.codes)) {
      setText("");
      setOpen(false);
    }
  };
  return (
    <form className={styles.formCard} onSubmit={(e) => void send(e)} aria-busy={busy}>
      <label className={styles.field}>
        <span>{t("rewards.codes.label")}</span>
        <textarea
          className={styles.input}
          dir="ltr"
          rows={6}
          value={text}
          aria-invalid={invalid !== undefined}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>{t("rewards.codes.file")}</span>
        <input
          type="file"
          accept=".txt,.csv,text/plain,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) {
              void file
                .text()
                .then((read) =>
                  setText(file.name.toLowerCase().endsWith(".csv") ? firstColumn(read) : read),
                );
            }
          }}
        />
      </label>
      <p className={styles.muted}>{t("rewards.codes.private")}</p>
      {invalid === undefined ? null : (
        <p role="alert" className={styles.alert}>
          {t(`rewards.codes.invalid.${invalid}`)}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("rewards.codes.save")}
        </button>
      </div>
    </form>
  );
}

/** The digital rewards whose codes run low, named with what is left (FR-512); nothing when none is. */
function LowCodes({ language, rewards }: Readonly<{ language: Language; rewards: RewardView[] }>) {
  const t = translatorFor(language);
  const low = lowCodeRewards(rewards);
  if (low.length === 0) {
    return null;
  }
  return (
    <div className={styles.alert} role="note" aria-labelledby="low-codes-title">
      <p id="low-codes-title">
        <strong>{t("rewards.lowCodes.title")}</strong>
      </p>
      <ul>
        {low.map((reward) => (
          <li key={reward.id}>
            {t("rewards.lowCodes.item", {
              name: reward.name[language] ?? reward.name[language === "ar" ? "en" : "ar"] ?? "",
              left: formatNumber(reward.stockLeft, language),
            })}
          </li>
        ))}
      </ul>
      <p className={styles.muted}>{t("rewards.lowCodes.hint")}</p>
    </div>
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
export function RewardsPanel({ language, organizerId, eventId, role }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  // Until the event arrives its zone is unknown: adding or editing waits, so no time is read in the wrong zone.
  const [event, setEvent] = useState<
    { timezone: string; terms: EventTerms; statusNow: string } | undefined
  >(undefined);
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
        const view = (
          result.body as { event: { timezone: string; terms?: unknown; statusNow: string } }
        ).event;
        setEvent({
          timezone: view.timezone,
          terms: readEventTerms(view.terms),
          statusNow: view.statusNow,
        });
      }
    });
  }, [base, load]);

  const run = async (
    work: () => Promise<PostResult>,
    done: MessageKey | ((body: unknown) => string),
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await work();
    const ok = !failed(result);
    if (ok) {
      setEditing(undefined);
      setNotice(typeof done === "function" ? done(result.body) : t(done));
      await load();
    }
    setBusy(false);
    return ok;
  };

  const rankLock =
    role !== "owner"
      ? ("ownerOnly" as const)
      : event === undefined || (event.statusNow !== "draft" && event.statusNow !== "scheduled")
        ? ("locked" as const)
        : undefined;

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
          {event === undefined ? null : (
            <DeskForm
              key={JSON.stringify(loaded.shop.desk) + loaded.shop.handoverConfirm}
              language={language}
              initial={deskDraftOf(loaded.shop, event.timezone)}
              busy={busy}
              submit={(desk) =>
                void run(
                  () => requestJson("PUT", `${base}/shop`, deskRequest(desk)),
                  "rewards.desk.saved",
                )
              }
            />
          )}
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
              deskSet={deskIsSet(loaded.shop.desk)}
              busy={busy}
              submit={(draft) => void save(draft)}
              cancel={() => setEditing(undefined)}
            />
          )}
          <LowCodes language={language} rewards={loaded.rewards} />
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
                upload={(codes) =>
                  run(
                    () =>
                      requestJson(
                        "POST",
                        `${base}/rewards/${reward.id}/codes`,
                        { codes },
                        { "idempotency-key": crypto.randomUUID() },
                      ),
                    (body) => {
                      const counts = body as { added: number; duplicates: number };
                      return t("rewards.codes.added", {
                        added: formatNumber(counts.added, language),
                        duplicates: formatNumber(counts.duplicates, language),
                      });
                    },
                  )
                }
              />
            ))}
          </ul>
          <ShopForm
            key={rankLock ?? "open"}
            language={language}
            initial={loaded.shop}
            rankLock={rankLock}
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
