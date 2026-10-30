"use client";
import { type SouvenirBody, type SouvenirRule } from "@questify/shared";
import { useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { EMPTY_SOUVENIR, SouvenirForm } from "#src/components/SouvenirForm.tsx";
import { SouvenirCard } from "#src/components/SouvenirCard.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { souvenirConfirmation } from "#src/lib/souvenir-copy.ts";
import { useSouvenirs, type SouvenirModel, type SouvenirProps } from "#src/lib/use-souvenirs.ts";
import { Button } from "#src/ui/Button.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";

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
    return model.problem === null ? <Muted role="status">{t("common.loading")}</Muted> : null;
  const list = model.list;
  return (
    <>
      {list.archived ? <Notice tone="info">{t("souvenir.closed")}</Notice> : null}
      <Muted role="status">
        {t(list.due > 0 || list.scanning > 0 ? "souvenir.pending" : "souvenir.complete")}
      </Muted>
      {list.failed > 0 ? (
        <Notice tone="danger" role="alert">
          {t("souvenir.failed")}
        </Notice>
      ) : null}
      {list.archived ? null : (
        <Button
          variant="quiet"
          disabled={model.busy}
          onClick={() => {
            void model.mutate("POST", "/process");
          }}
        >
          {t("souvenir.process")}
        </Button>
      )}
      {list.rules.length === 0 ? <EmptyState>{t("souvenir.empty")}</EmptyState> : null}
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
      <Stack as="section" aria-labelledby="souvenirs-title">
        <PageHeader titleId="souvenirs-title" title={t("souvenir.title")} />
        {model.problem === null ? null : (
          <Notice tone="danger" role="alert">
            {model.problem}
          </Notice>
        )}
        <Toolbar>
          <Button
            variant="quiet"
            onClick={() => {
              void model.load();
            }}
          >
            {t("souvenir.refresh")}
          </Button>
          {model.list?.archived === false ? (
            <Button
              variant="primary"
              disabled={model.busy}
              onClick={() => setEdit({ id: null, body: EMPTY_SOUVENIR })}
            >
              {t("souvenir.add")}
            </Button>
          ) : null}
        </Toolbar>
        <SouvenirContents model={model} props={props} setEdit={setEdit} choose={choose} />
        {edit === null || model.list?.archived !== false ? null : (
          <Editor edit={edit} model={model} language={props.language} close={() => setEdit(null)} />
        )}
      </Stack>
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
