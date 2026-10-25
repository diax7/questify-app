"use client";
import { type SouvenirBody, type SouvenirRule } from "@questify/shared";
import { useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { EMPTY_SOUVENIR, SouvenirForm } from "#src/components/SouvenirForm.tsx";
import { SouvenirCard } from "#src/components/SouvenirCard.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { souvenirConfirmation } from "#src/lib/souvenir-copy.ts";
import { useSouvenirs, type SouvenirModel, type SouvenirProps } from "#src/lib/use-souvenirs.ts";
import styles from "#src/components/layout.module.css";

type Edit = { id: string | null; body: SouvenirBody };
type Choice = { rule: SouvenirRule; action: "activate" | "stop" };
const draftOf = (rule: SouvenirRule): SouvenirBody => ({
  kind: rule.item.kind,
  name: rule.item.name,
  visualKey: rule.item.visualKey,
  audience: rule.audience,
  categoryId: rule.categoryId,
  rankFrom: rule.rankFrom,
  rankTo: rule.rankTo,
});

function SouvenirDialog({
  choice,
  model,
  language,
  close,
}: {
  choice: Choice;
  model: SouvenirModel;
  language: SouvenirProps["language"];
  close: () => void;
}) {
  const t = useTranslator(language);
  const categoryName =
    model.categories.find((category) => category.id === choice.rule.categoryId)?.name ?? "";
  return (
    <ConfirmDialog
      language={language}
      title={t(choice.action === "activate" ? "souvenir.confirm" : "souvenir.stopConfirm")}
      body={
        choice.action === "activate"
          ? souvenirConfirmation(t, choice.rule, choice.rule.item.name[language], categoryName)
          : t("souvenir.stopHint")
      }
      confirmLabel={t(choice.action === "activate" ? "souvenir.activate" : "souvenir.stop")}
      noteLabel={null}
      busy={model.busy}
      cancel={close}
      confirm={() => {
        void model
          .mutate(
            "POST",
            `/${choice.rule.id}/${choice.action}`,
            choice.action === "activate" ? { targetIds: choice.rule.targetIds } : undefined,
          )
          .then(close);
      }}
    />
  );
}

function Editor({
  edit,
  model,
  language,
  close,
}: {
  edit: Edit;
  model: SouvenirModel;
  language: SouvenirProps["language"];
  close: () => void;
}) {
  return (
    <SouvenirForm
      key={edit.id ?? "new"}
      language={language}
      initial={edit.body}
      editing={edit.id !== null}
      busy={model.busy}
      categories={model.categories}
      cancel={close}
      save={(body) => {
        void model
          .mutate(edit.id === null ? "POST" : "PATCH", edit.id === null ? "" : `/${edit.id}`, body)
          .then((ok) => {
            if (ok) close();
          });
      }}
    />
  );
}

function SouvenirContents({
  model,
  props,
  setEdit,
  choose,
}: {
  model: SouvenirModel;
  props: SouvenirProps;
  setEdit: (edit: Edit) => void;
  choose: (choice: Choice) => void;
}) {
  const t = useTranslator(props.language);
  const base = `/${props.language}/organizers/${props.organizerId}/events/${props.eventId}`;
  if (model.list === null)
    return model.problem === null ? <p role="status">{t("common.loading")}</p> : null;
  const list = model.list;
  return (
    <>
      {list.archived ? <p>{t("souvenir.closed")}</p> : null}
      <p role="status">
        {t(list.due > 0 || list.scanning > 0 ? "souvenir.pending" : "souvenir.complete")}
      </p>
      {list.failed > 0 ? <p role="alert">{t("souvenir.failed")}</p> : null}
      {list.archived ? null : (
        <button
          className={styles.quiet}
          disabled={model.busy}
          onClick={() => {
            void model.mutate("POST", "/process");
          }}
        >
          {t("souvenir.process")}
        </button>
      )}
      {list.rules.length === 0 ? <p>{t("souvenir.empty")}</p> : null}
      {list.rules.map((rule) => (
        <SouvenirCard
          key={rule.id}
          rule={rule}
          language={props.language}
          archived={list.archived}
          busy={model.busy}
          base={base}
          edit={() => setEdit({ id: rule.id, body: draftOf(rule) })}
          activate={() => choose({ rule, action: "activate" })}
          stop={() => choose({ rule, action: "stop" })}
          remove={() => {
            void model.mutate("DELETE", `/${rule.id}`);
          }}
        />
      ))}
    </>
  );
}

export function SouvenirsPanel(props: SouvenirProps) {
  const t = useTranslator(props.language);
  const model = useSouvenirs(props);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [choice, choose] = useState<Choice | null>(null);
  return (
    <>
      <section inert={choice !== null} className={styles.stack}>
        <h1 className={styles.title}>{t("souvenir.title")}</h1>
        {model.problem === null ? null : (
          <p role="alert" className={styles.alert}>
            {model.problem}
          </p>
        )}
        <div className={styles.actions}>
          <button
            className={styles.quiet}
            onClick={() => {
              void model.load();
            }}
          >
            {t("souvenir.refresh")}
          </button>
          {model.list?.archived === false ? (
            <button
              className={styles.button}
              disabled={model.busy}
              onClick={() => setEdit({ id: null, body: EMPTY_SOUVENIR })}
            >
              {t("souvenir.add")}
            </button>
          ) : null}
        </div>
        <SouvenirContents model={model} props={props} setEdit={setEdit} choose={choose} />
        {edit === null || model.list?.archived !== false ? null : (
          <Editor edit={edit} model={model} language={props.language} close={() => setEdit(null)} />
        )}
      </section>
      {choice === null ? null : (
        <SouvenirDialog
          choice={choice}
          model={model}
          language={props.language}
          close={() => choose(null)}
        />
      )}
    </>
  );
}
