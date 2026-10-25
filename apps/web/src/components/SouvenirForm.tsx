"use client";
import { type Language, type SouvenirBody, souvenirBodySchema } from "@questify/shared";
import { useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { SouvenirPreview } from "#src/components/SouvenirPreview.tsx";
import { souvenirAudienceCopy } from "#src/lib/souvenir-copy.ts";
import type { Translate } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

export const EMPTY_SOUVENIR: SouvenirBody = {
  kind: "frame",
  name: { ar: "", en: "" },
  visualKey: "frame-01",
  audience: "joined",
  categoryId: null,
  rankFrom: null,
  rankTo: null,
};
type Choice = { id: string; name: string };
type Fields = { body: SouvenirBody; change: (patch: Partial<SouvenirBody>) => void; t: Translate };
type Props = {
  language: Language;
  initial: SouvenirBody;
  editing: boolean;
  busy: boolean;
  categories: Choice[];
  save: (body: SouvenirBody) => void;
  cancel: () => void;
};

function KindFields({ body, editing, change, t }: Fields & { editing: boolean }) {
  return (
    <>
      <label className={styles.field}>
        <span>{t("souvenir.kind")}</span>
        <select
          className={styles.input}
          disabled={editing}
          value={body.kind}
          onChange={(e) => {
            const kind = e.target.value as SouvenirBody["kind"];
            change({
              kind,
              visualKey: kind === "frame" ? "frame-01" : kind === "character" ? "chest" : null,
            });
          }}
        >
          <option value="frame">{t("souvenir.frame")}</option>
          <option value="title">{t("souvenir.titleKind")}</option>
          <option value="character">{t("souvenir.character")}</option>
        </select>
      </label>
      {(["ar", "en"] as const).map((lang) => (
        <label className={styles.field} key={lang}>
          <span>{t(lang === "ar" ? "souvenir.nameAr" : "souvenir.nameEn")}</span>
          <input
            className={styles.input}
            required
            maxLength={60}
            dir={lang === "ar" ? "rtl" : "ltr"}
            value={body.name[lang]}
            onChange={(e) => change({ name: { ...body.name, [lang]: e.target.value } })}
          />
        </label>
      ))}
      {body.kind === "frame" ? (
        <label className={styles.field}>
          <span>{t("souvenir.visual")}</span>
          <select
            className={styles.input}
            value={body.visualKey ?? "frame-01"}
            onChange={(e) => change({ visualKey: e.target.value })}
          >
            {Array.from({ length: 14 }, (_, i) => (
              <option key={i} value={`frame-${String(i + 1).padStart(2, "0")}`}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}

function AudienceFields({ body, change, t, categories }: Fields & { categories: Choice[] }) {
  return (
    <>
      <label className={styles.field}>
        <span>{t("souvenir.audience")}</span>
        <select
          className={styles.input}
          value={body.audience}
          onChange={(e) => {
            const audience = e.target.value as SouvenirBody["audience"];
            change({
              audience,
              categoryId: audience === "category" ? (categories[0]?.id ?? null) : null,
              rankFrom: audience === "rank" ? 1 : null,
              rankTo: audience === "rank" ? 3 : null,
            });
          }}
        >
          {(["joined", "category", "all", "rank"] as const).map((audience) => (
            <option key={audience} value={audience}>
              {t(`souvenir.${audience}`)}
            </option>
          ))}
        </select>
      </label>
      {body.audience === "category" ? (
        <label className={styles.field}>
          <span>{t("souvenir.categoryLabel")}</span>
          <select
            className={styles.input}
            value={body.categoryId ?? ""}
            onChange={(e) => change({ categoryId: e.target.value })}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {body.audience === "rank"
        ? (["rankFrom", "rankTo"] as const).map((field) => (
            <label className={styles.field} key={field}>
              <span>{t(`souvenir.${field}`)}</span>
              <input
                className={styles.input}
                type="number"
                min={1}
                max={100}
                required
                value={body[field] ?? ""}
                onChange={(e) => change({ [field]: Number(e.target.value) })}
              />
            </label>
          ))
        : null}
    </>
  );
}

export function SouvenirForm({
  language,
  initial,
  editing,
  busy,
  categories,
  save,
  cancel,
}: Props) {
  const t = useTranslator(language);
  const [body, setBody] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const change = (patch: Partial<SouvenirBody>) => {
    setBody({ ...body, ...patch });
    setInvalid(false);
  };
  return (
    <form
      className={styles.card}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = souvenirBodySchema.safeParse(body);
        if (!parsed.success) setInvalid(true);
        else save(parsed.data);
      }}
    >
      <fieldset disabled={busy} className={styles.stack}>
        <KindFields body={body} editing={editing} change={change} t={t} />
        <p className={styles.muted}>{t("souvenir.publicName")}</p>
        <SouvenirPreview
          item={{ id: "preview", kind: body.kind, name: body.name, visualKey: body.visualKey }}
          language={language}
        />
        <AudienceFields body={body} change={change} t={t} categories={categories} />
        <p className={styles.muted}>{souvenirAudienceCopy(t, body)}</p>
        <p className={styles.muted}>{t("souvenir.eligibility")}</p>
        {invalid ? <p role="alert">{t("souvenir.invalid")}</p> : null}
        <div className={styles.actions}>
          <button className={styles.quiet} type="button" onClick={cancel}>
            {t("common.cancel")}
          </button>
          <button className={styles.button} type="submit">
            {t("souvenir.save")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
