"use client";

import {
  changeSetAppliedSchema,
  changeSetReadSchema,
  formatNumber,
  type ChangeSetItem,
  type ChangeSetView,
  type Language,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ItemRow } from "#src/components/ChangeSetItems.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import { readyIds, tally } from "#src/lib/change-sets.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Rows, Stack, Toolbar } from "#src/ui/Section.tsx";

const SET_TONE = { open: "info", applied: "success", closed: "neutral" } as const;

type Props = Readonly<{
  language: Language;
  /** `/v1/organizers/{id}/events/{id}`. */
  base: string;
  setId: string;
  back: () => void;
}>;

/** Reads one set with each item checked now; undefined while loading or when it could not be read. */
function useSet(path: string): {
  view: ChangeSetView | "failed" | undefined;
  reload: () => Promise<void>;
} {
  const [view, setView] = useState<ChangeSetView | "failed">();
  const reload = useCallback(async () => {
    const result = await requestJson("GET", path);
    const parsed = result.ok ? changeSetReadSchema.safeParse(result.body) : null;
    setView(parsed?.success === true ? parsed.data.changeSet : "failed");
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { view, reload };
}

/** The confirmation before the selected items are applied: each with what it changes (FR-1032, FR-1035). */
function ApplyDialog({
  language,
  items,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  items: readonly ChangeSetItem[];
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Dialog
      titleId="confirm-title"
      describedById="confirm-body"
      title={t("changeSets.applyTitle")}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={confirm}>
            {t("changeSets.applyConfirm")}
          </Button>
        </>
      }
    >
      <p id="confirm-body">{t("changeSets.applyBody")}</p>
      <Rows>
        {items.map((item) => (
          <ItemRow key={item.id} language={language} item={item} checked toggle={null} />
        ))}
      </Rows>
    </Dialog>
  );
}

/** The set's controls: select what is ready, apply the selection, close the set. */
function ReviewActions({
  language,
  view,
  selected,
  busy,
  selectAll,
  apply,
  close,
}: Readonly<{
  language: Language;
  view: ChangeSetView;
  selected: ReadonlySet<string>;
  busy: boolean;
  selectAll: () => void;
  apply: () => void;
  close: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Toolbar>
      <Button
        variant="secondary"
        disabled={busy || readyIds(view.items).length === 0}
        onClick={selectAll}
      >
        {t("changeSets.selectAll")}
      </Button>
      <Button variant="primary" disabled={busy || selected.size === 0} onClick={apply}>
        {t("changeSets.apply")}
      </Button>
      <Muted>{t("changeSets.selected", { count: formatNumber(selected.size, language) })}</Muted>
      <Button variant="danger" disabled={busy} onClick={close}>
        {t("changeSets.close")}
      </Button>
    </Toolbar>
  );
}

/** The set's apply and close calls with their state: busy, the refusal in the API's words, and the result line. */
function useReviewCalls(language: Language, path: string, reload: () => Promise<void>) {
  const t = useTranslator(language);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = async (suffix: "apply" | "close", payload: object) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson("POST", `${path}/${suffix}`, payload, {
      "idempotency-key": crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
    }
    return result;
  };

  const apply = async (itemIds: readonly string[]) => {
    const result = await call("apply", { itemIds });
    const parsed = result.ok ? changeSetAppliedSchema.safeParse(result.body) : null;
    if (parsed?.success === true) {
      const counts = tally(parsed.data.results);
      setNotice(
        t("changeSets.result", {
          applied: formatNumber(counts.applied, language),
          failed: formatNumber(counts.failed, language),
          stale: formatNumber(counts.stale, language),
        }),
      );
    }
    await reload();
  };

  const close = async () => {
    const result = await call("close", {});
    if (result.ok) {
      setNotice(t("changeSets.closed"));
    }
    await reload();
  };

  return { busy, problem, notice, apply, close };
}

/**
 * One change set for review (FR-1034, FR-1035): every item with its state now and what it changes, the reviewer picks
 * the ready ones and applies them after a confirmation that lists them, or closes the set without applying.
 */
export function ChangeSetReview({ language, base, setId, back }: Props) {
  const t = useTranslator(language);
  const { view, reload } = useSet(`${base}/change-sets/${setId}`);
  const calls = useReviewCalls(language, `${base}/change-sets/${setId}`, reload);
  const confirmation = useConfirmation(language);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (view === undefined || view === "failed") {
    return (
      <Stack>
        <Button variant="quiet" onClick={back}>
          {t("changeSets.back")}
        </Button>
        {view === "failed" ? (
          <Notice tone="danger" role="alert">
            {t("changeSets.loadFailed")}
          </Notice>
        ) : (
          <Muted>{t("common.loading")}</Muted>
        )}
      </Stack>
    );
  }
  const open = view.status === "open";
  return (
    <Stack as="section" aria-labelledby="change-set-title">
      <PageHeader
        titleId="change-set-title"
        title={t("changeSets.page.title")}
        meta={<Badge tone={SET_TONE[view.status]}>{t(`changeSets.status.${view.status}`)}</Badge>}
        actions={
          <Button variant="quiet" onClick={back}>
            {t("changeSets.back")}
          </Button>
        }
      />
      <Messages problem={calls.problem} notice={calls.notice} />
      {open ? (
        <ReviewActions
          language={language}
          view={view}
          selected={selected}
          busy={calls.busy}
          selectAll={() => setSelected(new Set(readyIds(view.items)))}
          apply={() => setApplying(true)}
          close={() =>
            confirmation.ask({
              title: t("changeSets.closeTitle"),
              body: t("changeSets.closeBody"),
              confirmLabel: t("changeSets.closeConfirm"),
              run: calls.close,
            })
          }
        />
      ) : null}
      <Rows>
        {view.items.map((item) => (
          <ItemRow
            key={item.id}
            language={language}
            item={item}
            checked={selected.has(item.id)}
            toggle={open ? toggle : null}
          />
        ))}
      </Rows>
      {applying ? (
        <ApplyDialog
          language={language}
          items={view.items.filter((item) => selected.has(item.id))}
          busy={calls.busy}
          cancel={() => setApplying(false)}
          confirm={() =>
            void calls.apply([...selected]).then(() => {
              setApplying(false);
              setSelected(new Set());
            })
          }
        />
      ) : null}
      {confirmation.dialog}
    </Stack>
  );
}

function Messages({
  problem,
  notice,
}: Readonly<{ problem: string | null; notice: string | null }>) {
  return (
    <>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
    </>
  );
}
