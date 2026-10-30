"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { FinalePanel } from "#src/components/FinalePanel.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  moveRow,
  planOf,
  rowsFor,
  SCENES,
  scenesToSave,
  toggleRow,
  type BigScreenPlan,
  type Scene,
  type SceneRow,
} from "#src/lib/big-screen.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button, ButtonLink } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Section, Stack, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The scenes in their order, each with a box and Up and Down; the offered ones only (FR-1612). */
function SceneList({
  language,
  rows,
  busy,
  change,
}: Readonly<{
  language: Language;
  rows: readonly SceneRow[];
  busy: boolean;
  change: (rows: readonly SceneRow[]) => void;
}>) {
  const t = useTranslator(language);
  const name = (scene: Scene) => t(`bigScreen.scene.${scene}`);
  return (
    <CardList>
      {rows.map((row, index) => (
        <Card as="li" key={row.scene}>
          <Checkbox
            checked={row.on}
            disabled={busy}
            onChange={() => change(toggleRow(rows, row.scene))}
            label={name(row.scene)}
          />
          <Toolbar>
            <Button
              variant="quiet"
              disabled={busy || index === 0}
              aria-label={t("bigScreen.up", { scene: name(row.scene) })}
              onClick={() => change(moveRow(rows, index, -1))}
            >
              ↑
            </Button>
            <Button
              variant="quiet"
              disabled={busy || index === rows.length - 1}
              aria-label={t("bigScreen.down", { scene: name(row.scene) })}
              onClick={() => change(moveRow(rows, index, 1))}
            >
              ↓
            </Button>
          </Toolbar>
        </Card>
      ))}
    </CardList>
  );
}

/** The plan read now, or why it could not be; a lost session goes back to sign-in. */
function usePlan(api: string, language: Language) {
  const t = useTranslator(language);
  const [plan, setPlan] = useState<BigScreenPlan | null>(null);
  const [rows, setRows] = useState<readonly SceneRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void requestJson("GET", api).then((result) => {
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      const read = result.ok ? planOf(result.body) : undefined;
      if (read === undefined) {
        setProblem(t("bigScreen.loadFailed"));
        return;
      }
      setPlan(read);
      setRows(rowsFor(read));
    });
  }, [api, language, t]);
  return { plan, rows, setRows, problem, setProblem };
}

/** The notes above the list, the list and Save, once the plan is read. */
function SceneEditor({
  language,
  plan,
  rows,
  busy,
  change,
  save,
}: Readonly<{
  language: Language;
  plan: BigScreenPlan;
  rows: readonly SceneRow[];
  busy: boolean;
  change: (rows: readonly SceneRow[]) => void;
  save: () => void;
}>) {
  const t = useTranslator(language);
  const locked = busy || !plan.enabled;
  return (
    <>
      {plan.enabled ? null : <Notice tone="danger">{t("bigScreen.off")}</Notice>}
      {plan.offered.length === SCENES.length ? null : <Muted>{t("bigScreen.rankingOff")}</Muted>}
      <Section title={t("bigScreen.scenes")}>
        <SceneList language={language} rows={rows} busy={locked} change={change} />
        {scenesToSave(rows).length === 0 ? <Muted>{t("bigScreen.none")}</Muted> : null}
        <Toolbar>
          <Button variant="primary" disabled={locked} onClick={save}>
            {t("bigScreen.save")}
          </Button>
        </Toolbar>
      </Section>
    </>
  );
}

/**
 * The event's Big screen page (T-504, FR-631, FR-1612): tick the scenes the big screen shows and put them in order;
 * the ranking is offered only while the event's ranking is on. Save replaces the list; screens follow within seconds.
 */
export function BigScreenPanel({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const api = `/v1/organizers/${organizerId}/events/${eventId}/big-screen`;
  const { plan, rows, setRows, problem, setProblem } = usePlan(api, language);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson(
      "PUT",
      api,
      { scenes: scenesToSave(rows) },
      { "idempotency-key": crypto.randomUUID() },
    );
    setBusy(false);
    if (result.ok) {
      setNotice(t("bigScreen.saved"));
    } else {
      setProblem(describeProblem(result.body, language, t).text);
    }
  };

  return (
    <Stack as="section" aria-labelledby="big-screen-title">
      <PageHeader
        titleId="big-screen-title"
        title={t("bigScreen.title")}
        description={t("bigScreen.intro")}
        actions={
          <ButtonLink href={`/${language}/organizers/${organizerId}/events/${eventId}/devices`}>
            {t("devices.link")}
          </ButtonLink>
        }
      />
      <Notes
        problem={problem}
        notice={notice}
        loading={plan === null && problem === null}
        language={language}
      />
      {plan === null ? null : (
        <SceneEditor
          language={language}
          plan={plan}
          rows={rows}
          busy={busy}
          change={setRows}
          save={() => void save()}
        />
      )}
      <FinalePanel language={language} organizerId={organizerId} eventId={eventId} />
    </Stack>
  );
}
