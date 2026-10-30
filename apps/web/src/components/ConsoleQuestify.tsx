"use client";

import {
  formatNumber,
  type AdminCampaign,
  type AdminQuest,
  type AdminQuestify,
  type Language,
} from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { NumberField } from "#src/components/NumberField.tsx";
import {
  BLANK_CAMPAIGN,
  BLANK_QUEST,
  campaignBodyOf,
  campaignDraftOf,
  invalidKey,
  metricKey,
  metricsFor,
  questBodyOf,
  questCanPay,
  questDraftOf,
  questPatchOf,
  readAdminQuestify,
  refusalKey,
  saudiStamp,
  secondInterestsQuest,
  targetFixed,
  withMetric,
  type CampaignDraft,
  type QuestDraft,
} from "#src/lib/console-questify.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { isTransientFailure, requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { useRequestKey } from "#src/lib/use-request-key.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { NavItem } from "#src/ui/Nav.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";

const API = "/v1/admin/questify";

type Editing =
  | Readonly<{ kind: "campaign"; id: string | null; draft: CampaignDraft }>
  | Readonly<{
      kind: "quest";
      id: string | null;
      campaignId: string | null;
      draft: QuestDraft;
      /** The quest can pay, so its gems cannot change (ADR-286). */
      gemsFixed: boolean;
    }>;
type Retiring = Readonly<{ kind: "campaign" | "quest"; id: string }>;

const either = (text: Readonly<{ ar: string; en: string }>, language: Language): string =>
  text[language] || text[language === "ar" ? "en" : "ar"];

/** The words for a failed call: this page's own for the Questify refusals, else the API's message. */
function problemOf(body: unknown, language: Language, t: Translate): string {
  const key = refusalKey(body);
  return key === undefined ? describeProblem(body, language, t).text : t(key);
}

function CampaignForm({
  language,
  draft,
  busy,
  change,
  cancel,
  submit,
}: Readonly<{
  language: Language;
  draft: CampaignDraft;
  busy: boolean;
  change: (patch: Partial<CampaignDraft>) => void;
  cancel: () => void;
  submit: (event: FormEvent) => void;
}>) {
  const t = translatorFor(language);
  const text = (key: "nameAr" | "nameEn", label: string) => (
    <Field label={label}>
      <Input
        dir={key === "nameAr" ? "rtl" : "ltr"}
        lang={key === "nameAr" ? "ar" : "en"}
        maxLength={80}
        value={draft[key]}
        disabled={busy}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </Field>
  );
  const time = (key: "startsAt" | "endsAt", label: string) => (
    <Field label={label}>
      <Input
        type="datetime-local"
        dir="ltr"
        required
        value={draft[key]}
        disabled={busy}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </Field>
  );
  return (
    <Form onSubmit={submit}>
      {text("nameAr", t("console.questify.field.nameAr"))}
      {text("nameEn", t("console.questify.field.nameEn"))}
      {time("startsAt", t("console.questify.field.startsAt"))}
      {time("endsAt", t("console.questify.field.endsAt"))}
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("console.questify.save")}
        </Button>
      </Toolbar>
    </Form>
  );
}

/**
 * What a quest counts, with its notices: "set your interests" fixes the target at 1, and a second one beside a live one
 * pays everyone who chose interests again (ADR-320).
 */
function MetricField({
  t,
  draft,
  campaignId,
  secondInterests,
  busy,
  change,
}: Readonly<{
  t: Translate;
  draft: QuestDraft;
  campaignId: string | null;
  secondInterests: boolean;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
}>) {
  return (
    <>
      <Field label={t("console.questify.field.metric")}>
        <Select
          value={draft.metric}
          disabled={busy}
          onChange={(event) =>
            change(withMetric(draft, event.target.value as QuestDraft["metric"]))
          }
        >
          {metricsFor(campaignId).map((metric) => (
            <option key={metric} value={metric}>
              {t(metricKey(metric))}
            </option>
          ))}
        </Select>
      </Field>
      {secondInterests ? (
        <Muted role="status">{t("console.questify.secondInterests")}</Muted>
      ) : null}
      {targetFixed(draft) ? <Muted>{t("console.questify.targetFixed")}</Muted> : null}
    </>
  );
}

function QuestForm({
  language,
  draft,
  campaignId,
  gemsFixed,
  secondInterests,
  busy,
  change,
  cancel,
  submit,
}: Readonly<{
  language: Language;
  draft: QuestDraft;
  campaignId: string | null;
  gemsFixed: boolean;
  /** Saving adds a second "set your interests" quest, which pays everyone who chose interests again. */
  secondInterests: boolean;
  busy: boolean;
  change: (patch: Partial<QuestDraft>) => void;
  cancel: () => void;
  submit: (event: FormEvent) => void;
}>) {
  const t = translatorFor(language);
  const text = (key: "titleAr" | "titleEn", label: string) => (
    <Field label={label}>
      <Input
        dir={key === "titleAr" ? "rtl" : "ltr"}
        lang={key === "titleAr" ? "ar" : "en"}
        maxLength={80}
        value={draft[key]}
        disabled={busy}
        onChange={(event) => change({ [key]: event.target.value })}
      />
    </Field>
  );
  const number = (key: "target" | "xp" | "gems" | "position", label: string) => (
    <NumberField
      label={label}
      value={draft[key]}
      invalid={false}
      disabled={busy || (key === "gems" && gemsFixed) || (key === "target" && targetFixed(draft))}
      change={(value) => change({ [key]: value })}
    />
  );
  return (
    <Form onSubmit={submit}>
      {text("titleAr", t("console.questify.field.titleAr"))}
      {text("titleEn", t("console.questify.field.titleEn"))}
      <MetricField
        t={t}
        draft={draft}
        campaignId={campaignId}
        secondInterests={secondInterests}
        busy={busy}
        change={change}
      />
      {number("target", t("console.questify.field.target"))}
      {number("xp", t("console.questify.field.xp"))}
      {number("gems", t("console.questify.field.gems"))}
      {gemsFixed ? <Muted>{t("console.questify.gemsFixed")}</Muted> : null}
      {number("position", t("console.questify.field.position"))}
      <Field label={t("console.questify.field.status")}>
        <Select
          value={draft.status}
          disabled={busy}
          onChange={(event) => change({ status: event.target.value as QuestDraft["status"] })}
        >
          {(["draft", "active"] as const).map((status) => (
            <option key={status} value={status}>
              {t(`console.questify.questStatus.${status}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("console.questify.save")}
        </Button>
      </Toolbar>
    </Form>
  );
}

function QuestRow({
  language,
  quest,
  busy,
  edit,
  retire,
}: Readonly<{
  language: Language;
  quest: AdminQuest;
  busy: boolean;
  edit: () => void;
  retire: () => void;
}>) {
  const t = translatorFor(language);
  const open = quest.status !== "retired";
  return (
    <Card as="li" data-testid="questify-quest">
      <Toolbar>
        <strong dir="auto">{either(quest.title, language)}</strong>
        <Badge>{t(`console.questify.questStatus.${quest.status}`)}</Badge>
      </Toolbar>
      <Muted>
        {t("console.questify.row", {
          metric: t(metricKey(quest.metric)),
          target: formatNumber(quest.target, language),
          xp: formatNumber(quest.xp, language),
          gems: formatNumber(quest.gems, language),
        })}
      </Muted>
      {open ? (
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={edit}>
            {t("console.questify.editQuest")}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={retire}>
            {t("console.questify.retireQuest")}
          </Button>
        </Toolbar>
      ) : null}
    </Card>
  );
}

type CampaignActions = Readonly<{
  edit: () => void;
  publish: () => void;
  retire: () => void;
  addQuest: () => void;
}>;

function CampaignHead({
  language,
  campaign,
  busy,
  actions,
}: Readonly<{
  language: Language;
  campaign: AdminCampaign;
  busy: boolean;
  actions: CampaignActions;
}>) {
  const t = translatorFor(language);
  const open = campaign.status !== "retired";
  const button = (label: string, onClick: () => void) => (
    <Button variant="quiet" disabled={busy} onClick={onClick}>
      {label}
    </Button>
  );
  return (
    <>
      <Toolbar>
        <strong dir="auto">{either(campaign.name, language)}</strong>
        <Badge>{t(`console.questify.campaignStatus.${campaign.status}`)}</Badge>
      </Toolbar>
      <Muted>
        {t("console.questify.window", {
          from: saudiStamp(campaign.startsAt, language),
          to: saudiStamp(campaign.endsAt, language),
        })}
      </Muted>
      {open ? (
        <Toolbar>
          {button(t("console.questify.editCampaign"), actions.edit)}
          {campaign.status === "draft"
            ? button(t("console.questify.publish"), actions.publish)
            : null}
          {button(t("console.questify.newQuest"), actions.addQuest)}
          {button(t("console.questify.retireCampaign"), actions.retire)}
        </Toolbar>
      ) : null}
    </>
  );
}

function QuestList({
  language,
  quests,
  busy,
  edit,
  retire,
}: Readonly<{
  language: Language;
  quests: readonly AdminQuest[];
  busy: boolean;
  edit: (quest: AdminQuest) => void;
  retire: (quest: AdminQuest) => void;
}>) {
  const t = translatorFor(language);
  return quests.length === 0 ? (
    <Muted>{t("console.questify.noQuests")}</Muted>
  ) : (
    <CardList>
      {quests.map((quest) => (
        <QuestRow
          key={quest.id}
          language={language}
          quest={quest}
          busy={busy}
          edit={() => edit(quest)}
          retire={() => retire(quest)}
        />
      ))}
    </CardList>
  );
}

/** What the page can be doing at once: one form open, or one retirement or publication waiting for its confirmation. */
function usePage(language: Language) {
  const t = translatorFor(language);
  const [view, setView] = useState<AdminQuestify | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRequestKey();
  const load = async (): Promise<boolean> => {
    const result = await requestJson("GET", API);
    const read = result.ok ? readAdminQuestify(result.body) : undefined;
    if (read === undefined) {
      setProblem(problemOf(result.body, language, t));
      return false;
    }
    setView(read);
    return true;
  };
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load();
    // Once per page, also under Strict Mode's double effect.
  }, []);

  /** One write: the checked body goes with an Idempotency-Key; the page reads again on success. */
  const write = async (
    call: Readonly<{ method: "POST" | "PUT"; path: string; body?: unknown; done: string }>,
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const signature = `${call.method} ${call.path} ${JSON.stringify(call.body ?? null)}`;
    const result: PostResult = await requestJson(call.method, `${API}${call.path}`, call.body, {
      "idempotency-key": request.keyFor(signature),
    });
    if (!result.ok) {
      if (!isTransientFailure(result)) {
        request.forget();
      }
      setProblem(problemOf(result.body, language, t));
      setBusy(false);
      return false;
    }
    request.forget();
    setNotice(call.done);
    await load();
    setBusy(false);
    return true;
  };
  return { view, problem, setProblem, notice, busy, write };
}

/** This page's item in the console's navigation. */
export function ConsoleQuestifyLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/questify`} current={current}>
      {t("console.questify.title")}
    </NavItem>
  );
}

function EditorTitle({ language, editing }: Readonly<{ language: Language; editing: Editing }>) {
  const t = translatorFor(language);
  const fresh = editing.id === null;
  const key =
    editing.kind === "campaign"
      ? fresh
        ? "console.questify.newCampaign"
        : "console.questify.editCampaign"
      : fresh
        ? "console.questify.newQuest"
        : "console.questify.editQuest";
  return <SubHeading as="h2">{t(key)}</SubHeading>;
}

/** The open form, for a campaign or a quest, in a card above the lists. */
function Editor({
  language,
  view,
  editing,
  setEditing,
  busy,
  submit,
}: Readonly<{
  language: Language;
  view: AdminQuestify | null;
  editing: Editing;
  setEditing: (next: Editing | null) => void;
  busy: boolean;
  submit: (event: FormEvent) => void;
}>) {
  const common = { language, busy, submit, cancel: () => setEditing(null) };
  return (
    <Card>
      <EditorTitle language={language} editing={editing} />
      {editing.kind === "campaign" ? (
        <CampaignForm
          {...common}
          draft={editing.draft}
          change={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
        />
      ) : (
        <QuestForm
          {...common}
          draft={editing.draft}
          campaignId={editing.campaignId}
          gemsFixed={editing.gemsFixed}
          secondInterests={secondInterestsQuest(view, editing.draft, editing.id)}
          change={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
        />
      )}
    </Card>
  );
}

type Doors = Readonly<{
  editCampaign: (campaign: AdminCampaign) => void;
  publish: (campaign: AdminCampaign) => void;
  retireCampaign: (campaign: AdminCampaign) => void;
  newQuest: (campaignId: string | null) => void;
  editQuest: (campaign: AdminCampaign | null, quest: AdminQuest) => void;
  retireQuest: (quest: AdminQuest) => void;
  newCampaign: () => void;
}>;

/** The always-on quests, then the campaigns with their quests. */
function Lists({
  language,
  view,
  busy,
  doors,
}: Readonly<{ language: Language; view: AdminQuestify; busy: boolean; doors: Doors }>) {
  const t = translatorFor(language);
  const add = (label: string, onClick: () => void) => (
    <Button variant="quiet" disabled={busy} onClick={onClick}>
      {label}
    </Button>
  );
  return (
    <>
      <SubHeading as="h2">{t("console.questify.alwaysOn")}</SubHeading>
      <QuestList
        language={language}
        quests={view.alwaysOn}
        busy={busy}
        edit={(quest) => doors.editQuest(null, quest)}
        retire={doors.retireQuest}
      />
      {add(t("console.questify.newQuest"), () => doors.newQuest(null))}
      <SubHeading as="h2">{t("console.questify.campaigns")}</SubHeading>
      {view.campaigns.length === 0 ? <Muted>{t("console.questify.noCampaigns")}</Muted> : null}
      <CardList>
        {view.campaigns.map((campaign) => (
          <Card as="li" key={campaign.id} data-testid="questify-campaign">
            <CampaignHead
              language={language}
              campaign={campaign}
              busy={busy}
              actions={{
                edit: () => doors.editCampaign(campaign),
                publish: () => doors.publish(campaign),
                retire: () => doors.retireCampaign(campaign),
                addQuest: () => doors.newQuest(campaign.id),
              }}
            />
            <QuestList
              language={language}
              quests={campaign.quests}
              busy={busy}
              edit={(quest) => doors.editQuest(campaign, quest)}
              retire={doors.retireQuest}
            />
          </Card>
        ))}
      </CardList>
      {add(t("console.questify.newCampaign"), doors.newCampaign)}
    </>
  );
}

type PageWrite = ReturnType<typeof usePage>["write"];

/** The confirmation before a campaign or quest is retired for good. */
function RetireDialog({
  language,
  retiring,
  busy,
  write,
  close,
}: Readonly<{
  language: Language;
  retiring: Retiring;
  busy: boolean;
  write: PageWrite;
  close: () => void;
}>) {
  const t = translatorFor(language);
  const campaign = retiring.kind === "campaign";
  const retire = async () => {
    await write({
      method: "POST",
      path: `/${campaign ? "campaigns" : "quests"}/${retiring.id}/retire`,
      done: t(campaign ? "console.questify.retiredCampaign" : "console.questify.retiredQuest"),
    });
    close();
  };
  return (
    <ConfirmDialog
      language={language}
      title={t("console.questify.retireTitle")}
      body={t("console.questify.retireBody")}
      confirmLabel={t(
        campaign ? "console.questify.retireCampaign" : "console.questify.retireQuest",
      )}
      noteLabel={null}
      busy={busy}
      cancel={close}
      confirm={() => void retire()}
    />
  );
}

/** The confirmation before a campaign is published: it cannot be undone and starts paying XP to players. */
function PublishDialog({
  language,
  campaignId,
  busy,
  write,
  close,
}: Readonly<{
  language: Language;
  campaignId: string;
  busy: boolean;
  write: PageWrite;
  close: () => void;
}>) {
  const t = translatorFor(language);
  const publish = async () => {
    await write({
      method: "POST",
      path: `/campaigns/${campaignId}/publish`,
      done: t("console.questify.published"),
    });
    close();
  };
  return (
    <ConfirmDialog
      language={language}
      title={t("console.questify.publishTitle")}
      body={t("console.questify.publishBody")}
      confirmLabel={t("console.questify.publish")}
      noteLabel={null}
      busy={busy}
      cancel={close}
      confirm={() => void publish()}
    />
  );
}

/**
 * The console's Questify quests (T-403c, FR-710, FR-711): always-on quests and seasonal campaigns, each created, edited,
 * published or retired here (never deleted: what players earned stays). Times are entered in Saudi time. Every write
 * carries an Idempotency-Key, and the API's refusals (`questify_conflict`, `invalid_questify`) are said in words.
 */
export function ConsoleQuestify({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const page = usePage(language);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [retiring, setRetiring] = useState<Retiring | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);

  const saveForm = async (submitted: FormEvent) => {
    submitted.preventDefault();
    if (editing === null) return;
    const call = callFor(editing, t);
    if (call.kind === "invalid") {
      page.setProblem(t(call.message));
      return;
    }
    if (await page.write(call.write)) {
      setEditing(null);
    }
  };

  const questForm = (campaign: AdminCampaign | null, quest?: AdminQuest) =>
    setEditing({
      kind: "quest",
      id: quest?.id ?? null,
      campaignId: campaign?.id ?? null,
      draft: quest === undefined ? BLANK_QUEST : questDraftOf(quest),
      gemsFixed: quest !== undefined && questCanPay(quest, campaign),
    });

  const doors: Doors = {
    editCampaign: (campaign) =>
      setEditing({ kind: "campaign", id: campaign.id, draft: campaignDraftOf(campaign) }),
    publish: (campaign) => {
      setRetiring(null);
      setPublishing(campaign.id);
    },
    retireCampaign: (campaign) => {
      setPublishing(null);
      setRetiring({ kind: "campaign", id: campaign.id });
    },
    newQuest: (campaignId) =>
      questForm(page.view?.campaigns.find((campaign) => campaign.id === campaignId) ?? null),
    editQuest: questForm,
    retireQuest: (quest) => {
      setPublishing(null);
      setRetiring({ kind: "quest", id: quest.id });
    },
    newCampaign: () => setEditing({ kind: "campaign", id: null, draft: BLANK_CAMPAIGN }),
  };

  return (
    <Stack as="section" aria-labelledby="console-questify-title">
      <PageHeader titleId="console-questify-title" title={t("console.questify.title")} />
      {page.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {page.problem}
        </Notice>
      )}
      {page.notice === null ? null : (
        <Notice tone="info" role="status">
          {page.notice}
        </Notice>
      )}
      {retiring === null ? null : (
        <RetireDialog
          language={language}
          retiring={retiring}
          busy={page.busy}
          write={page.write}
          close={() => setRetiring(null)}
        />
      )}
      {publishing === null ? null : (
        <PublishDialog
          language={language}
          campaignId={publishing}
          busy={page.busy}
          write={page.write}
          close={() => setPublishing(null)}
        />
      )}
      {editing === null ? null : (
        <Editor
          language={language}
          view={page.view}
          editing={editing}
          setEditing={setEditing}
          busy={page.busy}
          submit={(event) => void saveForm(event)}
        />
      )}
      {page.view === null ? (
        page.problem === null ? (
          <Muted>{t("common.loading")}</Muted>
        ) : null
      ) : (
        <Lists language={language} view={page.view} busy={page.busy} doors={doors} />
      )}
    </Stack>
  );
}

type Call =
  | Readonly<{ kind: "invalid"; message: ReturnType<typeof invalidKey> }>
  | Readonly<{
      kind: "write";
      write: Readonly<{ method: "POST" | "PUT"; path: string; body: unknown; done: string }>;
    }>;

/** Checks the open form and turns it into the request it sends, or says which field to fix. */
function callFor(editing: Editing, t: Translate): Call {
  const done = t("console.questify.saved");
  if (editing.kind === "campaign") {
    const checked = campaignBodyOf(editing.draft);
    if (!checked.ok) {
      return { kind: "invalid", message: invalidKey(checked.field) };
    }
    const path = editing.id === null ? "/campaigns" : `/campaigns/${editing.id}`;
    return {
      kind: "write",
      write: { method: editing.id === null ? "POST" : "PUT", path, body: checked.body, done },
    };
  }
  const checked =
    editing.id === null
      ? questBodyOf(editing.draft, editing.campaignId)
      : questPatchOf(editing.draft);
  if (!checked.ok) {
    return { kind: "invalid", message: invalidKey(checked.field) };
  }
  const path = editing.id === null ? "/quests" : `/quests/${editing.id}`;
  return {
    kind: "write",
    write: { method: editing.id === null ? "POST" : "PUT", path, body: checked.body, done },
  };
}
