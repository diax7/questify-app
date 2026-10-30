"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import {
  named,
  prizeSettingsOf,
  nextRank,
  rankLabel,
  type Prize,
  type PrizeSettings,
} from "#src/lib/prizes.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Select, Textarea } from "#src/ui/Field.tsx";
import { Card, CardList, Section, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  joinCode: string | null;
  live: boolean;
}>;

type Draft = {
  id: string | null;
  kind: Prize["kind"];
  rankFrom: string;
  rankTo: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
};

const blank = (next: number): Draft => ({
  id: null,
  kind: "item",
  rankFrom: String(next),
  rankTo: String(next),
  nameAr: "",
  nameEn: "",
  descriptionAr: "",
  descriptionEn: "",
});

const draftOf = (prize: Prize): Draft => ({
  id: prize.id,
  kind: prize.kind,
  rankFrom: String(prize.rankFrom),
  rankTo: String(prize.rankTo),
  nameAr: prize.name.ar ?? "",
  nameEn: prize.name.en ?? "",
  descriptionAr: prize.description.ar ?? "",
  descriptionEn: prize.description.en ?? "",
});

function TextField({
  label,
  value,
  lang,
  max,
  multiline = false,
  change,
}: Readonly<{
  label: string;
  value: string;
  lang: Language;
  max: number;
  multiline?: boolean;
  change: (text: string) => void;
}>) {
  const shared = { value, lang, dir: directionOf(lang), maxLength: max };
  return (
    <Field label={label}>
      {multiline ? (
        <Textarea {...shared} rows={4} onChange={(e) => change(e.target.value)} />
      ) : (
        <Input {...shared} onChange={(e) => change(e.target.value)} />
      )}
    </Field>
  );
}

function RankField({
  label,
  value,
  disabled,
  change,
}: Readonly<{ label: string; value: string; disabled: boolean; change: (text: string) => void }>) {
  return (
    <Field label={label}>
      <Input
        type="number"
        inputMode="numeric"
        dir="ltr"
        min={1}
        max={100}
        value={value}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      />
    </Field>
  );
}

/** The add-or-edit form: once the event is live only the names and descriptions change (ADR-162). */
function PrizeForm({
  language,
  draft,
  live,
  busy,
  set,
  save,
  cancel,
}: Readonly<{
  language: Language;
  draft: Draft;
  live: boolean;
  busy: boolean;
  set: (change: Partial<Draft>) => void;
  save: () => void;
  cancel: () => void;
}>) {
  const t = translatorFor(language);
  return (
    <Card>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <FieldGroup layout="columns">
          <RankField
            label={t("prizes.from")}
            value={draft.rankFrom}
            disabled={live}
            change={(rankFrom) => set({ rankFrom })}
          />
          <RankField
            label={t("prizes.to")}
            value={draft.rankTo}
            disabled={live}
            change={(rankTo) => set({ rankTo })}
          />
          <Field label={t("prizes.kind")}>
            <Select
              value={draft.kind}
              disabled={draft.id !== null}
              onChange={(e) =>
                set({ kind: e.target.value === "experience" ? "experience" : "item" })
              }
            >
              <option value="item">{t("prizes.kind.item")}</option>
              <option value="experience">{t("prizes.kind.experience")}</option>
            </Select>
          </Field>
        </FieldGroup>
        <FieldGroup layout="columns">
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
            multiline
            change={(descriptionAr) => set({ descriptionAr })}
          />
          <TextField
            label={t("prizes.descriptionEn")}
            value={draft.descriptionEn}
            lang="en"
            max={2000}
            multiline
            change={(descriptionEn) => set({ descriptionEn })}
          />
        </FieldGroup>
        <Toolbar>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("prizes.save")}
          </Button>
          <Button variant="quiet" onClick={cancel}>
            {t("common.cancel")}
          </Button>
        </Toolbar>
      </Form>
    </Card>
  );
}

/** The organizer's own rules text, shown under the fixed block on the rules page (ADR-165). */
function RulesEditor({
  language,
  rules,
  busy,
  save,
  rulesPage,
}: Readonly<{
  language: Language;
  rules: PrizeSettings["rules"];
  busy: boolean;
  save: (rules: { ar: string; en: string }) => void;
  rulesPage: string | null;
}>) {
  const t = translatorFor(language);
  const [ar, setAr] = useState(rules.ar ?? "");
  const [en, setEn] = useState(rules.en ?? "");
  return (
    <Section title={t("prizes.rules")} info={infoTip(t, "prizes.rulesHint")}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save({ ar, en });
        }}
      >
        <FieldGroup layout="columns">
          <TextField
            label={t("prizes.rulesAr")}
            value={ar}
            lang="ar"
            max={10_000}
            multiline
            change={setAr}
          />
          <TextField
            label={t("prizes.rulesEn")}
            value={en}
            lang="en"
            max={10_000}
            multiline
            change={setEn}
          />
        </FieldGroup>
        <Toolbar>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("prizes.rulesSave")}
          </Button>
          {rulesPage === null ? null : (
            <TextLink href={rulesPage} target="_blank" rel="noreferrer">
              {t("prizes.rulesPage")}
            </TextLink>
          )}
        </Toolbar>
      </Form>
    </Section>
  );
}

const bodyOf = (draft: Draft, live: boolean) => {
  const text = {
    name: { ar: draft.nameAr, en: draft.nameEn },
    description: { ar: draft.descriptionAr, en: draft.descriptionEn },
  };
  const ranks = { rankFrom: Number(draft.rankFrom), rankTo: Number(draft.rankTo) };
  if (draft.id === null) {
    return { kind: draft.kind, ...ranks, ...text };
  }
  return live ? text : { ...ranks, ...text };
};

/** The prize list, the switch and the rules, with every write going through the API and its answer shown. */
function usePrizes(eventApi: string, language: Language) {
  const t = translatorFor(language);
  const [settings, setSettings] = useState<PrizeSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = useCallback(
    (body: unknown, fallback: string) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      setProblem(code === undefined ? fallback : describeProblem(body, language, t).text);
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/rank-prizes`);
    const read = result.ok ? prizeSettingsOf(result.body) : undefined;
    if (read === undefined) {
      failed(result.body, t("prizes.loadFailed"));
    } else {
      setSettings(read);
    }
  }, [eventApi, failed, t]);
  useEffect(() => {
    void load();
  }, [load]);
  const write = async (
    method: "POST" | "PATCH" | "PUT" | "DELETE",
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
      failed(result.body, t("prizes.loadFailed"));
      return false;
    }
    setProblem(null);
    setNotice(said);
    await load();
    return true;
  };
  return { settings, problem, notice, busy, write };
}

function PrizeRow({
  prize,
  language,
  live,
  edit,
  remove,
}: Readonly<{
  prize: Prize;
  language: Language;
  live: boolean;
  edit: () => void;
  remove: () => void;
}>) {
  const t = translatorFor(language);
  const label = rankLabel(prize);
  const values = Object.fromEntries(
    Object.entries(label.values).map(([key, value]) => [key, formatNumber(value, language)]),
  );
  return (
    <Card as="li">
      <Toolbar>
        <strong>{t(label.key, values)}</strong>
        <span dir="auto">{named(prize.name, language)}</span>
        <Badge>{t(prize.kind === "item" ? "prizes.kind.item" : "prizes.kind.experience")}</Badge>
      </Toolbar>
      <Toolbar>
        <Button variant="quiet" onClick={edit}>
          {t("prizes.edit")}
        </Button>
        {live ? null : (
          <Button variant="quiet" onClick={remove}>
            {t("prizes.remove")}
          </Button>
        )}
      </Toolbar>
    </Card>
  );
}

/** The page's last problem and last notice, or that it is still loading. */
export function Notes({
  problem,
  notice,
  loading,
  language,
}: Readonly<{
  problem: string | null;
  notice: string | null;
  loading: boolean;
  language: Language;
}>) {
  return (
    <>
      {loading ? <Muted>{translatorFor(language)("common.loading")}</Muted> : null}
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

/** The event's rank prize switch (FR-519): locked once the event is live. */
function SwitchCard({
  language,
  on,
  live,
  busy,
  flip,
}: Readonly<{ language: Language; on: boolean; live: boolean; busy: boolean; flip: () => void }>) {
  const t = translatorFor(language);
  return (
    <Card>
      <p>{t(on ? "prizes.on" : "prizes.off")}</p>
      {live ? (
        <Muted>{t("prizes.locked")}</Muted>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={flip}>
          {t(on ? "prizes.turnOff" : "prizes.turnOn")}
        </Button>
      )}
    </Card>
  );
}

/**
 * Rank prizes (FR-519, T-214): the prizes per rank range, the event's switch and the official rules text. Ranks, kinds
 * and the switch lock once the event is live; names, descriptions and the rules stay editable. Owners and editors.
 */
export function PrizesPanel({ language, organizerId, eventId, joinCode, live }: Props) {
  const t = translatorFor(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { settings, problem, notice, busy, write } = usePrizes(eventApi, language);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<Prize | null>(null);
  if (settings === null) {
    return <Notes problem={problem} notice={null} loading={problem === null} language={language} />;
  }
  const remove = async (prize: Prize) => {
    await write("DELETE", `/rank-prizes/${prize.id}`, undefined, t("prizes.removed"));
    setRemoving(null);
  };
  const save = async (current: Draft) => {
    const path = current.id === null ? "/rank-prizes" : `/rank-prizes/${current.id}`;
    const method = current.id === null ? "POST" : "PATCH";
    if (await write(method, path, bodyOf(current, live), t("prizes.saved"))) {
      setDraft(null);
    }
  };
  return (
    <>
      {removing === null ? null : (
        <ConfirmDialog
          language={language}
          title={t("prizes.removeTitle")}
          body={t("prizes.removeBody")}
          confirmLabel={t("prizes.remove")}
          noteLabel={null}
          busy={busy}
          cancel={() => setRemoving(null)}
          confirm={() => void remove(removing)}
        />
      )}
      <Section title={t("prizes.title")} titleId="prizes-title" info={infoTip(t, "prizes.intro")}>
        <Notes problem={problem} notice={notice} loading={false} language={language} />
        <SwitchCard
          language={language}
          on={settings.rankPrizes}
          live={live}
          busy={busy}
          flip={() =>
            void write(
              "PUT",
              "/rank-prizes",
              { rankPrizes: !settings.rankPrizes },
              t("prizes.saved"),
            )
          }
        />
        {settings.prizes.length === 0 ? <EmptyState>{t("prizes.empty")}</EmptyState> : null}
        <CardList>
          {settings.prizes.map((prize) => (
            <PrizeRow
              key={prize.id}
              prize={prize}
              language={language}
              live={live}
              edit={() => setDraft(draftOf(prize))}
              remove={() => setRemoving(prize)}
            />
          ))}
        </CardList>
        {draft === null && !live ? (
          <Button variant="primary" onClick={() => setDraft(blank(nextRank(settings.prizes)))}>
            {t("prizes.add")}
          </Button>
        ) : null}
        {draft === null ? null : (
          <PrizeForm
            language={language}
            draft={draft}
            live={live}
            busy={busy}
            set={(change) => setDraft({ ...draft, ...change })}
            save={() => void save(draft)}
            cancel={() => setDraft(null)}
          />
        )}
      </Section>
      <RulesEditor
        language={language}
        rules={settings.rules}
        busy={busy}
        save={(rules) => void write("PUT", "/rank-prizes", { rules }, t("prizes.rulesSaved"))}
        rulesPage={joinCode === null ? null : `/${language}/e/${joinCode}/rules`}
      />
    </>
  );
}
