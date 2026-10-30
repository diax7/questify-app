"use client";

import {
  SPONSOR_LIMITS,
  SPONSOR_TIERS,
  formatNumber,
  tierKey,
  type Language,
  type TeamSponsor,
} from "@questify/shared";
import { useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { SponsorTags, type SponsorWrites } from "#src/components/SponsorTags.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  LISTED_NAMES,
  blankSponsor,
  draftOf,
  sponsorName,
  sponsorPayload,
  taggedLabels,
  type SponsorDraft,
  type TagChoices,
} from "#src/lib/sponsors.ts";
import { sponsorFailure, useSponsors, type SponsorsProps } from "#src/lib/use-sponsors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

/** The panel's writes: each runs one request and says what happened, or why not. */
function useSponsorWrites(props: SponsorsProps) {
  const { language } = props;
  const t = useTranslator(language);
  const model = useSponsors(props);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run: SponsorWrites["run"] = async (method, suffix, body, done) => {
    setNotice(null);
    setFailure(null);
    const result = await model.write(method, suffix, body);
    if (result.ok) setNotice(done());
    else setFailure(sponsorFailure(result.body, language, t));
    return result.ok;
  };
  const writes: SponsorWrites = {
    busy: model.busy,
    failure,
    clearFailure: () => setFailure(null),
    run,
  };
  return { model, notice, failure, writes, t };
}

function SponsorForm({
  language,
  draft,
  busy,
  problem,
  change,
  cancel,
  save,
}: Readonly<{
  language: Language;
  draft: SponsorDraft;
  busy: boolean;
  problem: string | null;
  change: (draft: SponsorDraft) => void;
  cancel: () => void;
  save: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <Section title={t(draft.id === null ? "sponsors.page.add" : "sponsors.page.edit")} level={3}>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {problem === null ? null : (
          <Notice tone="danger" role="alert">
            {problem}
          </Notice>
        )}
        <FieldGroup layout="columns">
          <Field label={t("sponsors.page.nameAr")}>
            <Input
              dir="rtl"
              lang="ar"
              maxLength={SPONSOR_LIMITS.name}
              disabled={busy}
              value={draft.nameAr}
              onChange={(event) => change({ ...draft, nameAr: event.target.value })}
            />
          </Field>
          <Field label={t("sponsors.page.nameEn")}>
            <Input
              dir="ltr"
              lang="en"
              maxLength={SPONSOR_LIMITS.name}
              disabled={busy}
              value={draft.nameEn}
              onChange={(event) => change({ ...draft, nameEn: event.target.value })}
            />
          </Field>
        </FieldGroup>
        <FieldGroup layout="columns">
          <Field label={t("sponsors.page.tier")}>
            <Select
              disabled={busy}
              value={draft.tier}
              onChange={(event) =>
                change({ ...draft, tier: event.target.value as SponsorDraft["tier"] })
              }
            >
              {SPONSOR_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {t(tierKey(tier))}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("sponsors.page.booth")}>
            <Input
              dir="auto"
              maxLength={SPONSOR_LIMITS.booth}
              disabled={busy}
              value={draft.booth}
              onChange={(event) => change({ ...draft, booth: event.target.value })}
            />
          </Field>
        </FieldGroup>
        <Toolbar align="end">
          <Button variant="quiet" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("sponsors.page.save")}
          </Button>
        </Toolbar>
      </Form>
    </Section>
  );
}

type Opened = Readonly<{
  select: (id: string | null) => void;
  edit: (sponsor: TeamSponsor) => void;
  remove: (sponsor: TeamSponsor) => void;
}>;

function SponsorRows({
  language,
  sponsors,
  selectedId,
  busy,
  opened,
}: Readonly<{
  language: Language;
  sponsors: readonly TeamSponsor[];
  selectedId: string | null;
  busy: boolean;
  opened: Opened;
}>) {
  const t = useTranslator(language);
  if (sponsors.length === 0) return <EmptyState>{t("sponsors.page.empty")}</EmptyState>;
  return (
    <Rows>
      {sponsors.map((sponsor) => (
        <Row
          key={sponsor.id}
          main={
            <>
              <strong>{sponsorName(sponsor, language)}</strong>{" "}
              <Badge>{t(tierKey(sponsor.tier))}</Badge>
              <Muted>
                {sponsor.booth === null
                  ? null
                  : `${t("sponsors.boothLine", { booth: sponsor.booth })} · `}
                {t("sponsors.page.tagged", { count: formatNumber(sponsor.tags.length, language) })}
              </Muted>
            </>
          }
        >
          <Button
            variant={sponsor.id === selectedId ? "primary" : "secondary"}
            aria-pressed={sponsor.id === selectedId}
            onClick={() => opened.select(sponsor.id === selectedId ? null : sponsor.id)}
          >
            {t("sponsors.page.tags")}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => opened.edit(sponsor)}>
            {t("sponsors.page.edit")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => opened.remove(sponsor)}>
            {t("sponsors.page.delete")}
          </Button>
        </Row>
      ))}
    </Rows>
  );
}

/** The confirmation names the tagged items that lose the sponsor (FR-1301). */
function RemoveDialog({
  language,
  sponsor,
  choices,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  sponsor: TeamSponsor;
  choices: TagChoices;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  const names = taggedLabels(sponsor, choices);
  const joined = names.slice(0, LISTED_NAMES).join(language === "ar" ? "، " : ", ");
  const items =
    names.length > LISTED_NAMES
      ? t("sponsors.page.deleteMore", {
          items: joined,
          count: formatNumber(names.length - LISTED_NAMES, language),
        })
      : joined;
  return (
    <ConfirmDialog
      language={language}
      title={t("sponsors.page.deleteTitle")}
      body={
        names.length === 0
          ? t("sponsors.page.deleteBodyNone")
          : t("sponsors.page.deleteBody", { items })
      }
      confirmLabel={t("sponsors.page.delete")}
      noteLabel={null}
      busy={busy}
      cancel={cancel}
      confirm={confirm}
    />
  );
}

function SponsorsNotices({
  language,
  problem,
  notice,
  failure,
  loading,
}: Readonly<{
  language: Language;
  problem: string | null;
  notice: string | null;
  failure: string | null;
  loading: boolean;
}>) {
  const t = useTranslator(language);
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
      {failure === null ? null : (
        <Notice tone="danger" role="alert">
          {failure}
        </Notice>
      )}
      {loading ? <Muted role="status">{t("common.loading")}</Muted> : null}
    </>
  );
}

type Writes = ReturnType<typeof useSponsorWrites>;

type PanelState = Readonly<{
  draft: SponsorDraft | null;
  selectedId: string | null;
  removing: TeamSponsor | null;
  setDraft: (draft: SponsorDraft | null) => void;
  setSelectedId: (id: string | null) => void;
  setRemoving: (sponsor: TeamSponsor | null) => void;
}>;

/** What the panel's buttons do: save a sponsor, delete one. */
function useSponsorActions({ writes, t }: Writes, state: PanelState) {
  const save = (form: SponsorDraft) => {
    const path = form.id === null ? "/sponsors" : `/sponsors/${form.id}`;
    void writes
      .run(form.id === null ? "POST" : "PUT", path, sponsorPayload(form), () =>
        t("sponsors.page.saved"),
      )
      .then((ok) => {
        if (ok) state.setDraft(null);
      });
  };
  const remove = () => {
    const gone = state.removing;
    if (gone === null) return;
    void writes
      .run("DELETE", `/sponsors/${gone.id}`, undefined, () => t("sponsors.page.deleted"))
      .then(() => {
        if (state.selectedId === gone.id) state.setSelectedId(null);
        state.setRemoving(null);
      });
  };
  return { save, remove };
}

/** The form, the list of sponsors and the tags of the one picked. */
function SponsorsContent({
  language,
  all,
  sponsors,
  state,
  actions,
}: Readonly<{
  language: Language;
  all: Writes;
  sponsors: readonly TeamSponsor[];
  state: PanelState;
  actions: ReturnType<typeof useSponsorActions>;
}>) {
  const { model, failure, writes } = all;
  const { draft, selectedId } = state;
  const selected = sponsors.find((sponsor) => sponsor.id === selectedId) ?? null;
  return (
    <>
      {draft === null ? null : (
        <SponsorForm
          key={draft.id ?? "new"}
          language={language}
          draft={draft}
          busy={model.busy}
          problem={failure}
          change={state.setDraft}
          cancel={() => {
            state.setDraft(null);
            writes.clearFailure();
          }}
          save={() => actions.save(draft)}
        />
      )}
      <SponsorRows
        language={language}
        sponsors={sponsors}
        selectedId={selectedId}
        busy={model.busy}
        opened={{
          select: state.setSelectedId,
          edit: (sponsor) => state.setDraft(draftOf(sponsor)),
          remove: state.setRemoving,
        }}
      />
      {selected === null ? null : (
        <SponsorTags
          key={selected.id}
          language={language}
          sponsor={selected}
          sponsors={sponsors}
          choices={model.choices}
          writes={writes}
        />
      )}
    </>
  );
}

export function SponsorsPanel(props: SponsorsProps) {
  const { language } = props;
  const all = useSponsorWrites(props);
  const { model, notice, failure, t } = all;
  const [draft, setDraft] = useState<SponsorDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamSponsor | null>(null);
  const state = { draft, selectedId, removing, setDraft, setSelectedId, setRemoving };
  const actions = useSponsorActions(all, state);
  const sponsors = model.sponsors;
  return (
    <>
      <Stack as="section" aria-labelledby="sponsors-title">
        <PageHeader
          titleId="sponsors-title"
          title={t("sponsors.page.title")}
          info={infoTip(t, "sponsors.page.intro")}
          actions={
            <Button
              variant="primary"
              disabled={sponsors === null || model.busy}
              onClick={() => setDraft(blankSponsor())}
            >
              {t("sponsors.page.add")}
            </Button>
          }
        />
        <SponsorsNotices
          language={language}
          problem={model.problem}
          notice={notice}
          failure={draft === null ? failure : null}
          loading={sponsors === null}
        />
        {sponsors === null ? null : (
          <SponsorsContent
            language={language}
            all={all}
            sponsors={sponsors}
            state={state}
            actions={actions}
          />
        )}
      </Stack>
      {removing === null ? null : (
        <RemoveDialog
          language={language}
          sponsor={removing}
          choices={model.choices}
          busy={model.busy}
          cancel={() => setRemoving(null)}
          confirm={actions.remove}
        />
      )}
    </>
  );
}
