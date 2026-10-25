"use client";
import {
  souvenirListSchema,
  type Language,
  type SouvenirBody,
  type SouvenirList,
  type SouvenirRule,
} from "@questify/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { EMPTY_SOUVENIR, SouvenirForm } from "#src/components/SouvenirForm.tsx";
import { SouvenirPreview } from "#src/components/SouvenirPreview.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { souvenirConfirmation } from "#src/lib/souvenir-copy.ts";
import styles from "#src/components/layout.module.css";

type Props = { language: Language; organizerId: string; eventId: string };
function useSouvenirs({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const api = `/api/v1/organizers/${organizerId}/events/${eventId}`;
  const [list, setList] = useState<SouvenirList | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());
  const failed = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code === "unauthenticated" || code === "session_expired") {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      if (code === "forbidden" || code === "not_found") setList(null);
      setProblem(
        body === undefined ? t("souvenir.loadFailed") : describeProblem(body, language, t).text,
      );
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const current = generation.current;
    const result = await requestJson("GET", `${api}/souvenirs`);
    if (current !== generation.current) return;
    const parsed = result.ok ? souvenirListSchema.safeParse(result.body) : null;
    if (parsed?.success === true) {
      setList(parsed.data);
      setProblem(null);
    } else failed(result.body);
  }, [api, failed]);
  useEffect(() => {
    generation.current += 1;
    const current = generation.current;
    setList(null);
    setProblem(null);
    keys.current.clear();
    void load();
    void requestJson("GET", `${api}/quests`).then((result) => {
      if (current !== generation.current || !result.ok) return;
      const choices = (
        result.body as {
          categories?: { id: string; name: { ar: string | null; en: string | null } }[];
        }
      ).categories;
      setCategories(
        (choices ?? []).map((category) => ({
          id: category.id,
          name: category.name[language] ?? category.name.en ?? category.name.ar ?? "",
        })),
      );
    });
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [api, language, load]);
  const mutate = async (
    method: "POST" | "PATCH" | "DELETE",
    suffix: string,
    body?: SouvenirBody | { targetIds: string[] },
  ) => {
    if (busy) return false;
    setBusy(true);
    const current = generation.current;
    const operation = JSON.stringify([method, suffix, body ?? null]);
    const key = keys.current.get(operation) ?? crypto.randomUUID();
    keys.current.set(operation, key);
    const result = await requestJson(method, `${api}/souvenirs${suffix}`, body, {
      "idempotency-key": key,
    });
    if (current !== generation.current) return false;
    setBusy(false);
    const parsed = result.ok ? souvenirListSchema.safeParse(result.body) : null;
    if (parsed?.success !== true) {
      failed(result.body);
      return false;
    }
    keys.current.delete(operation);
    setList(parsed.data);
    setProblem(null);
    return true;
  };
  return { list, busy, problem, categories, load, mutate };
}

export function SouvenirsPanel(props: Props) {
  const t = useTranslator(props.language);
  const model = useSouvenirs(props);
  const [edit, setEdit] = useState<{ id: string | null; body: SouvenirBody } | null>(null);
  const [activate, setActivate] = useState<{
    rule: SouvenirRule;
    action: "activate" | "stop";
  } | null>(null);
  const base = `/${props.language}/organizers/${props.organizerId}/events/${props.eventId}`;
  const draftOf = (rule: SouvenirRule): SouvenirBody => ({
    kind: rule.item.kind,
    name: rule.item.name,
    visualKey: rule.item.visualKey,
    audience: rule.audience,
    categoryId: rule.categoryId,
    rankFrom: rule.rankFrom,
    rankTo: rule.rankTo,
  });
  return (
    <>
      <section inert={activate !== null} className={styles.stack}>
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
        {model.list === null ? (
          model.problem === null ? (
            <p role="status">{t("common.loading")}</p>
          ) : null
        ) : (
          <>
            {model.list.archived ? <p>{t("souvenir.closed")}</p> : null}
            <p role="status">
              {t(
                model.list.due > 0 || model.list.scanning > 0
                  ? "souvenir.pending"
                  : "souvenir.complete",
              )}
            </p>
            {model.list.failed > 0 ? <p role="alert">{t("souvenir.failed")}</p> : null}
            {model.list.archived ? null : (
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
            {model.list.rules.length === 0 ? <p>{t("souvenir.empty")}</p> : null}
            {model.list.rules.map((rule) => (
              <article key={rule.id} className={styles.card}>
                <SouvenirPreview item={rule.item} language={props.language} />
                <h2 className={styles.subtitle}>{rule.item.name[props.language]}</h2>
                <p>
                  {t(`souvenir.${rule.status}`)} · {t(`souvenir.${rule.audience}`)}
                  {rule.audience === "rank" ? ` (${rule.rankFrom}–${rule.rankTo})` : ""}
                </p>
                <p>{t("souvenir.targets", { count: rule.targetCount })}</p>
                <p>{t("souvenir.granted", { count: rule.granted })}</p>
                {rule.waitingForResults ? (
                  <p>
                    {t("souvenir.waiting")}{" "}
                    <a className={styles.textLink} href={`${base}/prizes`}>
                      {t("souvenir.results")}
                    </a>
                  </p>
                ) : null}
                {model.list?.archived ? null : (
                  <div className={styles.actions}>
                    {rule.status === "draft" ? (
                      <>
                        <button
                          className={styles.quiet}
                          disabled={model.busy}
                          onClick={() => setEdit({ id: rule.id, body: draftOf(rule) })}
                        >
                          {t("souvenir.edit")}
                        </button>
                        <button
                          className={styles.button}
                          disabled={model.busy}
                          onClick={() => setActivate({ rule, action: "activate" })}
                        >
                          {t("souvenir.activate")}
                        </button>
                        <button
                          className={styles.quiet}
                          disabled={model.busy}
                          onClick={() => {
                            void model.mutate("DELETE", `/${rule.id}`);
                          }}
                        >
                          {t("souvenir.remove")}
                        </button>
                      </>
                    ) : null}
                    {rule.status === "active" ? (
                      <button
                        className={styles.quiet}
                        disabled={model.busy}
                        onClick={() => {
                          setActivate({ rule, action: "stop" });
                        }}
                      >
                        {t("souvenir.stop")}
                      </button>
                    ) : null}
                  </div>
                )}
              </article>
            ))}
          </>
        )}
        {edit === null || model.list?.archived !== false ? null : (
          <SouvenirForm
            key={edit.id ?? "new"}
            language={props.language}
            initial={edit.body}
            editing={edit.id !== null}
            busy={model.busy}
            categories={model.categories}
            cancel={() => setEdit(null)}
            save={(body) => {
              void model
                .mutate(
                  edit.id === null ? "POST" : "PATCH",
                  edit.id === null ? "" : `/${edit.id}`,
                  body,
                )
                .then((ok) => {
                  if (ok) setEdit(null);
                });
            }}
          />
        )}
      </section>
      {activate === null ? null : (
        <ConfirmDialog
          language={props.language}
          title={t(activate.action === "activate" ? "souvenir.confirm" : "souvenir.stopConfirm")}
          body={
            activate.action === "activate"
              ? souvenirConfirmation(
                  t,
                  activate.rule,
                  activate.rule.item.name[props.language],
                  model.categories.find((category) => category.id === activate.rule.categoryId)
                    ?.name ?? "",
                )
              : t("souvenir.stopHint")
          }
          confirmLabel={t(activate.action === "activate" ? "souvenir.activate" : "souvenir.stop")}
          noteLabel={null}
          busy={model.busy}
          cancel={() => setActivate(null)}
          confirm={() => {
            void model
              .mutate(
                "POST",
                `/${activate.rule.id}/${activate.action}`,
                activate.action === "activate" ? { targetIds: activate.rule.targetIds } : undefined,
              )
              .then(() => {
                setActivate(null);
              });
          }}
        />
      )}
    </>
  );
}
