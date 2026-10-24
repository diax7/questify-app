"use client";

import { formatNumber, type Language, type MessageKey } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { directionOf } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { handleOf } from "#src/lib/players.ts";
import { named } from "#src/lib/prizes.ts";
import {
  linked,
  questItemMissesOf,
  questItemsOf,
  type QuestItem,
  type QuestItemMiss,
} from "#src/lib/quest-items.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

const MISS_REASON: Readonly<Record<QuestItemMiss["reason"], MessageKey>> = {
  out_of_stock: "questItems.reason.outOfStock",
  claim_closed: "questItems.reason.claimClosed",
};

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

type Draft = {
  id: string | null;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  stock: string;
};

const BLANK: Draft = {
  id: null,
  nameAr: "",
  nameEn: "",
  descriptionAr: "",
  descriptionEn: "",
  stock: "10",
};

const draftOf = (item: QuestItem): Draft => ({
  id: item.id,
  nameAr: item.name.ar ?? "",
  nameEn: item.name.en ?? "",
  descriptionAr: item.description.ar ?? "",
  descriptionEn: item.description.en ?? "",
  stock: String(item.stockTotal),
});

const bodyOf = (draft: Draft) => ({
  name: { ar: draft.nameAr, en: draft.nameEn },
  description: { ar: draft.descriptionAr, en: draft.descriptionEn },
  stockTotal: Number(draft.stock),
});

function TextField({
  label,
  value,
  lang,
  max,
  change,
}: Readonly<{
  label: string;
  value: string;
  lang: Language;
  max: number;
  change: (text: string) => void;
}>) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        className={styles.input}
        value={value}
        lang={lang}
        dir={directionOf(lang)}
        maxLength={max}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
}

/** The add-or-edit form: names, descriptions and the stock (never below what is out; the API checks). */
function ItemForm({
  language,
  draft,
  busy,
  set,
  save,
  cancel,
}: Readonly<{
  language: Language;
  draft: Draft;
  busy: boolean;
  set: (change: Partial<Draft>) => void;
  save: () => void;
  cancel: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <form
      className={styles.form}
      aria-label={t("questItems.title")}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <TextField
        label={t("prizes.nameAr")}
        value={draft.nameAr}
        lang="ar"
        max={120}
        change={(nameAr) => set({ nameAr })}
      />
      <TextField
        label={t("prizes.nameEn")}
        value={draft.nameEn}
        lang="en"
        max={120}
        change={(nameEn) => set({ nameEn })}
      />
      <TextField
        label={t("prizes.descriptionAr")}
        value={draft.descriptionAr}
        lang="ar"
        max={2000}
        change={(descriptionAr) => set({ descriptionAr })}
      />
      <TextField
        label={t("prizes.descriptionEn")}
        value={draft.descriptionEn}
        lang="en"
        max={2000}
        change={(descriptionEn) => set({ descriptionEn })}
      />
      <label className={styles.field}>
        <span>{t("questItems.stock")}</span>
        <input
          className={styles.input}
          type="number"
          inputMode="numeric"
          dir="ltr"
          min={0}
          max={100_000}
          value={draft.stock}
          onChange={(e) => set({ stock: e.target.value })}
        />
      </label>
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("questItems.save")}
        </button>
        <button type="button" className={styles.quiet} onClick={cancel}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The players who missed an item (FR-1617), read when asked for. */
function MissList({
  language,
  misses,
}: Readonly<{ language: Language; misses: readonly QuestItemMiss[] }>) {
  const t = useTranslator(language);
  if (misses.length === 0) {
    return <p className={styles.muted}>{t("questItems.noMisses")}</p>;
  }
  return (
    <ul className={styles.list}>
      {misses.map((miss) => (
        <li key={`${miss.at}-${miss.username ?? ""}`} className={styles.row}>
          <span dir="auto">{handleOf(miss.username, language)}</span>
          <span dir="auto">{named(miss.sourceName, language)}</span>
          <span className={styles.badge}>{t(MISS_REASON[miss.reason])}</span>
        </li>
      ))}
    </ul>
  );
}

function ItemRow({
  item,
  language,
  misses,
  edit,
  remove,
  showMisses,
}: Readonly<{
  item: QuestItem;
  language: Language;
  misses: readonly QuestItemMiss[] | undefined;
  edit: () => void;
  remove: () => void;
  showMisses: () => void;
}>) {
  const t = useTranslator(language);
  const name = named(item.name, language);
  const sources = [...item.quests, ...item.categories].map((source) =>
    named(source.name, language),
  );
  const out = item.stockLeft <= 0 && linked(item);
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong dir="auto">{name}</strong>
        <span>
          {t("questItems.left", {
            left: formatNumber(item.stockLeft, language),
            total: formatNumber(item.stockTotal, language),
          })}
        </span>
      </p>
      <p className={styles.muted} dir="auto">
        {sources.length === 0
          ? t("questItems.notLinked")
          : t("questItems.givenBy", { names: sources.join("، ") })}
      </p>
      {out ? (
        <p role="alert" className={styles.alert}>
          {t("questItems.ranOut", { item: name, count: formatNumber(item.missed, language) })}
        </p>
      ) : item.missed > 0 ? (
        <p className={styles.muted}>
          {t("questItems.missed", { count: formatNumber(item.missed, language) })}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={edit}>
          {t("prizes.edit")}
        </button>
        <button type="button" className={styles.quiet} onClick={remove}>
          {t("prizes.remove")}
        </button>
        {item.missed > 0 && misses === undefined ? (
          <button type="button" className={styles.quiet} onClick={showMisses}>
            {t("questItems.seeMisses")}
          </button>
        ) : null}
      </div>
      {misses === undefined ? null : <MissList language={language} misses={misses} />}
    </li>
  );
}

/** The items, with every write going through the API and its answer shown. */
function useQuestItems(eventApi: string, language: Language) {
  const t = useTranslator(language);
  const [items, setItems] = useState<readonly QuestItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      setProblem(
        code === undefined ? t("questItems.loadFailed") : describeProblem(body, language, t).text,
      );
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/quest-items`);
    const read = result.ok ? questItemsOf(result.body) : undefined;
    if (read === undefined) {
      failed(result.body);
    } else {
      setItems(read);
    }
  }, [eventApi, failed]);
  useEffect(() => {
    void load();
  }, [load]);
  const write = async (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    payload: object | undefined,
    said: string,
  ): Promise<boolean> => {
    setBusy(true);
    const headers: Record<string, string> =
      method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {};
    const result = await requestJson(method, `${eventApi}${path}`, payload, headers);
    setBusy(false);
    if (!result.ok) {
      failed(result.body);
      return false;
    }
    setProblem(null);
    setNotice(said);
    await load();
    return true;
  };
  const missesOf = async (id: string): Promise<readonly QuestItemMiss[] | undefined> => {
    const result = await requestJson("GET", `${eventApi}/quest-items/${id}/misses`);
    const read = result.ok ? questItemMissesOf(result.body) : undefined;
    if (read === undefined) {
      failed(result.body);
    }
    return read;
  };
  return { items, problem, notice, busy, write, missesOf };
}

/**
 * Quest items (FR-522, FR-1617, T-304d): items a quest or category gives at the prize desk, their stock, what is out,
 * and who got points only once one ran out. Owners and editors; the quest and category forms pick them.
 */
export function QuestItemsPanel({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { items, problem, notice, busy, write, missesOf } = useQuestItems(eventApi, language);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<QuestItem | null>(null);
  const [misses, setMisses] = useState<Readonly<Record<string, readonly QuestItemMiss[]>>>({});
  if (items === null) {
    return <Notes problem={problem} notice={null} loading={problem === null} language={language} />;
  }
  const save = async (current: Draft) => {
    const path = current.id === null ? "/quest-items" : `/quest-items/${current.id}`;
    if (
      await write(
        current.id === null ? "POST" : "PATCH",
        path,
        bodyOf(current),
        t("questItems.saved"),
      )
    ) {
      setDraft(null);
    }
  };
  const remove = async (item: QuestItem) => {
    await write("DELETE", `/quest-items/${item.id}`, undefined, t("questItems.removed"));
    setRemoving(null);
  };
  const showMisses = async (item: QuestItem) => {
    const read = await missesOf(item.id);
    if (read !== undefined) {
      setMisses({ ...misses, [item.id]: read });
    }
  };
  return (
    <section className={styles.panel} aria-labelledby="quest-items-title">
      {removing === null ? null : (
        <ConfirmDialog
          language={language}
          title={t("questItems.removeTitle")}
          body={t("questItems.removeBody")}
          confirmLabel={t("prizes.remove")}
          noteLabel={null}
          busy={busy}
          cancel={() => setRemoving(null)}
          confirm={() => void remove(removing)}
        />
      )}
      <h2 id="quest-items-title" className={styles.title}>
        {t("questItems.title")}
      </h2>
      <p className={styles.muted}>{t("questItems.intro")}</p>
      <Notes problem={problem} notice={notice} loading={false} language={language} />
      {items.length === 0 ? <p className={styles.muted}>{t("questItems.empty")}</p> : null}
      <ul className={styles.list}>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            language={language}
            misses={misses[item.id]}
            edit={() => setDraft(draftOf(item))}
            remove={() => setRemoving(item)}
            showMisses={() => void showMisses(item)}
          />
        ))}
      </ul>
      {draft === null ? (
        <button type="button" className={styles.button} onClick={() => setDraft(BLANK)}>
          {t("questItems.add")}
        </button>
      ) : (
        <ItemForm
          language={language}
          draft={draft}
          busy={busy}
          set={(change) => setDraft({ ...draft, ...change })}
          save={() => void save(draft)}
          cancel={() => setDraft(null)}
        />
      )}
    </section>
  );
}
