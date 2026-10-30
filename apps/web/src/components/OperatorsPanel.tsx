"use client";

import type { Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { QrImage } from "#src/components/CodesPanel.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { nameOf } from "#src/lib/players.ts";
import {
  ABILITIES,
  PRESETS,
  abilityKey,
  inviteBody,
  presetKey,
  printable,
  withAbility,
  type InviteKind,
  type InviteView,
  type OperatorView,
  type Preset,
} from "#src/lib/operators.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import codeStyles from "#src/components/codes.module.css";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Form, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Section, Stack, Toolbar } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

type Station = Readonly<{ id: string; title: string }>;

type Shared = Readonly<{
  language: Language;
  busy: boolean;
  /** Runs one write; false when it failed (the panel shows why). */
  run: (method: "POST" | "PUT" | "DELETE", path: string, payload?: unknown) => Promise<boolean>;
}>;

/**
 * An event's operators (T-204, FR-901 to FR-909, FR-1720): the owner invites people by a personal QR, a batch of QRs
 * with a preset, or email; sets each operator's abilities, quest limit and may-play; removes them at once; and prints
 * the open personal codes. Editors see the list without the codes (the API gives them no claim address).
 */
export function OperatorsPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = useTranslator(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const loaded = useRef(false);
  const [operators, setOperators] = useState<OperatorView[] | null>(null);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const failed = (body: unknown) => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(
      code === undefined ? t("operators.loadFailed") : describeProblem(body, language, t).text,
    );
  };

  const load = async () => {
    const [list, quests] = await Promise.all([
      requestJson("GET", `${base}/operators?lang=${language}`),
      requestJson("GET", `${base}/quests`),
    ]);
    if (!list.ok) {
      failed(list.body);
      return;
    }
    const body = list.body as { operators: OperatorView[]; invites: InviteView[] };
    setOperators(body.operators);
    setInvites(body.invites);
    if (quests.ok) {
      const categories = (quests.body as { categories: CategoryView[] }).categories;
      setStations(
        categories.flatMap((category) =>
          category.quests
            .filter((quest) => quest.verification.includes("my_qr"))
            .map((quest) => ({ id: quest.id, title: textFor(quest.title, language) })),
        ),
      );
    }
  };

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load();
  });

  const run: Shared["run"] = async (method, path, payload) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const headers: Record<string, string> =
      method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {};
    const result = await requestJson(method, `${base}${path}`, payload, headers);
    setBusy(false);
    if (!result.ok) {
      failed(result.body);
      return false;
    }
    await load();
    return true;
  };

  const shared: Shared = { language, busy, run };
  return (
    <Stack as="section" aria-labelledby="operators-title">
      <PageHeader
        titleId="operators-title"
        title={t("operators.title")}
        description={t("operators.intro")}
      />
      {myRole === "owner" ? (
        <NewInviteForm {...shared} sent={() => setNotice(t("operators.sent"))} />
      ) : (
        <Muted>{t("operators.ownerOnly")}</Muted>
      )}
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
      <OperatorsSection
        {...shared}
        operators={operators}
        stations={stations}
        canEdit={myRole === "owner"}
      />
      <InvitesList {...shared} invites={invites} canEdit={myRole === "owner"} />
      {myRole === "owner" ? <PrintSheet language={language} invites={printable(invites)} /> : null}
    </Stack>
  );
}

/** The operators who joined, each with what they may do. */
function OperatorsSection({
  operators,
  stations,
  canEdit,
  ...shared
}: Shared &
  Readonly<{
    operators: readonly OperatorView[] | null;
    stations: readonly Station[];
    canEdit: boolean;
  }>) {
  const t = useTranslator(shared.language);
  return (
    <Section title={t("operators.listTitle")}>
      {operators === null ? (
        <Muted>{t("common.loading")}</Muted>
      ) : operators.length === 0 ? (
        <EmptyState>{t("operators.none")}</EmptyState>
      ) : (
        <CardList>
          {operators.map((operator) => (
            <OperatorRow
              key={operator.id}
              {...shared}
              operator={operator}
              stations={stations}
              canEdit={canEdit}
            />
          ))}
        </CardList>
      )}
    </Section>
  );
}

function NewInviteForm({ language, busy, run, sent }: Shared & Readonly<{ sent: () => void }>) {
  const t = useTranslator(language);
  const [kind, setKind] = useState<InviteKind>("personal");
  const [label, setLabel] = useState("");
  const [count, setCount] = useState(10);
  const [email, setEmail] = useState("");
  const [preset, setPreset] = useState<Preset>("full");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = inviteBody({ kind, label, count, email, preset }, language);
    if (await run("POST", "/operators/invites", body)) {
      setLabel("");
      setEmail("");
      if (kind === "email") {
        sent();
      }
    }
  };

  return (
    <Section title={t("operators.newTitle")}>
      <Form onSubmit={(event) => void submit(event)}>
        <Field label={t("operators.kind")}>
          <Select
            value={kind}
            disabled={busy}
            onChange={(changed) => setKind(changed.target.value as InviteKind)}
          >
            <option value="personal">{t("operators.kind.personal")}</option>
            <option value="batch">{t("operators.kind.batch")}</option>
            <option value="email">{t("operators.kind.email")}</option>
          </Select>
        </Field>
        {kind === "email" ? (
          <Field label={t("operators.email")}>
            <Input
              type="email"
              dir="ltr"
              required
              maxLength={254}
              autoComplete="off"
              value={email}
              disabled={busy}
              onChange={(changed) => setEmail(changed.target.value)}
            />
          </Field>
        ) : (
          <Field label={t("operators.label")} help={t("operators.labelHint")}>
            <Input
              required
              maxLength={56}
              value={label}
              disabled={busy}
              onChange={(changed) => setLabel(changed.target.value)}
            />
          </Field>
        )}
        {kind === "batch" ? (
          <Field label={t("operators.count")}>
            <Input
              type="number"
              dir="ltr"
              min={1}
              max={100}
              required
              value={count}
              disabled={busy}
              onChange={(changed) => setCount(Number(changed.target.value))}
            />
          </Field>
        ) : null}
        <Field label={t("operators.preset")}>
          <Select
            value={preset}
            disabled={busy}
            onChange={(changed) => setPreset(changed.target.value as Preset)}
          >
            {PRESETS.map((item) => (
              <option key={item} value={item}>
                {t(presetKey(item))}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>
          {t("operators.create")}
        </Button>
      </Form>
    </Section>
  );
}

function OperatorRow({
  language,
  busy,
  run,
  operator,
  stations,
  canEdit,
}: Shared & Readonly<{ operator: OperatorView; stations: readonly Station[]; canEdit: boolean }>) {
  const t = useTranslator(language);
  const [abilities, setAbilities] = useState<readonly string[]>(operator.abilities);
  const [canPlay, setCanPlay] = useState(operator.canPlay);
  const [questIds, setQuestIds] = useState<readonly string[]>(operator.questIds);
  const [confirming, setConfirming] = useState(false);
  const path = `/operators/${operator.id}`;
  const save = () => void run("PUT", path, { abilities, canPlay, questIds });

  return (
    <Card as="li">
      <Toolbar>
        <strong>
          <bdi>{operator.username}</bdi>
        </strong>
        {operator.claimedVia === null ? null : (
          <Muted as="span">{t("operators.via", { label: operator.claimedVia.label })}</Muted>
        )}
      </Toolbar>
      <FieldGroup legend={t("operators.abilities")} layout="choices" disabled={!canEdit || busy}>
        {ABILITIES.map((ability) => (
          <Checkbox
            key={ability}
            checked={abilities.includes(ability)}
            onChange={(changed) =>
              setAbilities(withAbility(abilities, ability, changed.target.checked))
            }
            label={t(abilityKey(ability))}
          />
        ))}
      </FieldGroup>
      <Checkbox
        checked={canPlay}
        disabled={!canEdit || busy}
        onChange={(changed) => setCanPlay(changed.target.checked)}
        label={t("operators.canPlay")}
      />
      <FieldGroup legend={t("operators.quests")} layout="choices" disabled={!canEdit || busy}>
        {questIds.length === 0 ? <Muted>{t("operators.allQuests")}</Muted> : null}
        {stations.map((station) => (
          <Checkbox
            key={station.id}
            checked={questIds.includes(station.id)}
            onChange={(changed) =>
              setQuestIds(
                changed.target.checked
                  ? [...questIds, station.id]
                  : questIds.filter((id) => id !== station.id),
              )
            }
            label={station.title}
          />
        ))}
      </FieldGroup>
      {canEdit ? (
        <Toolbar>
          <Button variant="primary" disabled={busy} onClick={save}>
            {t("operators.save")}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => setConfirming(true)}>
            {t("operators.remove")}
          </Button>
          {confirming ? (
            <Dialog
              titleId={`remove-${operator.id}`}
              title={t("operators.removeTitle", { name: operator.username })}
              cancel={() => setConfirming(false)}
              busy={busy}
              actions={
                <>
                  <Button variant="secondary" onClick={() => setConfirming(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button variant="danger" disabled={busy} onClick={() => void run("DELETE", path)}>
                    {t("operators.remove")}
                  </Button>
                </>
              }
            >
              <p>{t("operators.removeBody")}</p>
              <p>{t("devices.removeNote")}</p>
            </Dialog>
          ) : null}
        </Toolbar>
      ) : null}
    </Card>
  );
}

function InvitesList({
  language,
  busy,
  run,
  invites,
  canEdit,
}: Shared & Readonly<{ invites: readonly InviteView[]; canEdit: boolean }>) {
  const t = useTranslator(language);
  const statusOf = (invite: InviteView) =>
    invite.status === "claimed"
      ? t("operators.status.claimed", {
          name: nameOf(invite.claimedBy?.username ?? null, language),
        })
      : t(`operators.status.${invite.status}`);
  return (
    <>
      <Section title={t("operators.invitesTitle")}>
        {invites.length === 0 ? <EmptyState>{t("operators.noInvites")}</EmptyState> : null}
        <CardList>
          {invites.map((invite) => (
            <Card as="li" key={invite.id}>
              <Toolbar>
                <Badge>
                  {t(invite.kind === "email" ? "operators.kind.email" : "operators.kind.personal")}
                </Badge>
                {invite.kind === "email" && invite.email !== null ? (
                  <bdi dir="ltr">{invite.email}</bdi>
                ) : (
                  <bdi>{invite.label}</bdi>
                )}
                <Muted as="span">{statusOf(invite)}</Muted>
                {canEdit && invite.status === "open" ? (
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => void run("DELETE", `/operators/invites/${invite.id}`)}
                  >
                    {t("operators.revoke")}
                  </Button>
                ) : null}
              </Toolbar>
            </Card>
          ))}
        </CardList>
      </Section>
    </>
  );
}

/** FR-902: the open personal codes, one card each, printed by the browser like the quest codes. */
function PrintSheet({
  language,
  invites,
}: Readonly<{ language: Language; invites: ReadonlyArray<InviteView & { url: string }> }>) {
  const t = useTranslator(language);
  if (invites.length === 0) {
    return null;
  }
  return (
    <>
      <div className={codeStyles.controls}>
        <Muted>{t("operators.printHint")}</Muted>
        <Button variant="primary" onClick={() => window.print()}>
          {t("operators.print")}
        </Button>
      </div>
      <div className={codeStyles.sheet}>
        {invites.map((invite) => (
          <article key={invite.id} className={codeStyles.card}>
            <QrImage text={invite.url} label={t("operators.printCard", { label: invite.label })} />
            <p className={codeStyles.title}>
              <bdi>{invite.label}</bdi>
            </p>
            <p className={codeStyles.small}>{t("operators.printHint")}</p>
          </article>
        ))}
      </div>
    </>
  );
}
