"use client";
import { type Language, type SouvenirBody, souvenirBodySchema } from "@questify/shared";
import { useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { SouvenirPreview } from "#src/components/SouvenirPreview.tsx";
import { souvenirAudienceCopy } from "#src/lib/souvenir-copy.ts";
import type { Translate } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Select } from "#src/ui/Field.tsx";
import { Toolbar } from "#src/ui/Section.tsx";

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
      <Field label={t("souvenir.kind")}>
        <Select
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
        </Select>
      </Field>
      {(["ar", "en"] as const).map((lang) => (
        <Field label={t(lang === "ar" ? "souvenir.nameAr" : "souvenir.nameEn")}>
          <Input
            required
            maxLength={60}
            dir={lang === "ar" ? "rtl" : "ltr"}
            value={body.name[lang]}
            onChange={(e) => change({ name: { ...body.name, [lang]: e.target.value } })}
          />
        </Field>
      ))}
      {body.kind === "frame" ? (
        <Field label={t("souvenir.visual")}>
          <Select
            value={body.visualKey ?? "frame-01"}
            onChange={(e) => change({ visualKey: e.target.value })}
          >
            {Array.from({ length: 14 }, (_, i) => (
              <option key={i} value={`frame-${String(i + 1).padStart(2, "0")}`}>
                {i + 1}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
    </>
  );
}

function AudienceFields({ body, change, t, categories }: Fields & { categories: Choice[] }) {
  return (
    <>
      <Field label={t("souvenir.audience")}>
        <Select
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
        </Select>
      </Field>
      {body.audience === "category" ? (
        <Field label={t("souvenir.categoryLabel")}>
          <Select
            value={body.categoryId ?? ""}
            onChange={(e) => change({ categoryId: e.target.value })}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {body.audience === "rank"
        ? (["rankFrom", "rankTo"] as const).map((field) => (
            <Field label={t(`souvenir.${field}`)}>
              <Input
                type="number"
                min={1}
                max={100}
                required
                value={body[field] ?? ""}
                onChange={(e) => change({ [field]: Number(e.target.value) })}
              />
            </Field>
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
    <Form
      card
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = souvenirBodySchema.safeParse(body);
        if (!parsed.success) setInvalid(true);
        else save(parsed.data);
      }}
    >
      <FieldGroup disabled={busy}>
        <KindFields body={body} editing={editing} change={change} t={t} />
        <Muted>{t("souvenir.publicName")}</Muted>
        <SouvenirPreview
          item={{ id: "preview", kind: body.kind, name: body.name, visualKey: body.visualKey }}
          language={language}
        />
        <AudienceFields body={body} change={change} t={t} categories={categories} />
        <Muted>{souvenirAudienceCopy(t, body)}</Muted>
        <Muted>{t("souvenir.eligibility")}</Muted>
        {invalid ? (
          <Notice tone="danger" role="alert">
            {t("souvenir.invalid")}
          </Notice>
        ) : null}
        <Toolbar>
          <Button variant="quiet" onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit">
            {t("souvenir.save")}
          </Button>
        </Toolbar>
      </FieldGroup>
    </Form>
  );
}
