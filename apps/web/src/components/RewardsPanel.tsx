"use client";

import {
  DEFAULT_TERMS,
  formatEventTime,
  formatNumber,
  readEventTerms,
  termFor,
  type EventTerms,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { NumberField } from "#src/components/NumberField.tsx";
import { SponsorBadge } from "#src/components/SponsorBadge.tsx";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import {
  DESK_WINDOWS,
  HANDOVER_CONFIRM,
  REWARD_KINDS,
  SECTIONS,
  blankReward,
  createRewardBody,
  daysFieldInvalid,
  daysRule,
  deskDraftOf,
  deskEndsBeforeClose,
  deskIsSet,
  deskProblem,
  deskRequest,
  editRewardBody,
  firstColumn,
  lowCodeRewards,
  nextWindow,
  parseCodes,
  rewardDraftOf,
  rewardProblem,
  shopDraftProblem,
  shopRequest,
  type CodesProblem,
  type DaysRule,
  type DeskDraft,
  type DeskField,
  type RewardDraft,
  type RewardField,
  type ShopField,
  type RewardView,
  type ShopSettings,
} from "#src/lib/rewards.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import {
  Checkbox,
  Field,
  FieldGroup,
  Form,
  Input,
  Radio,
  Select,
  Textarea,
} from "#src/ui/Field.tsx";
import { Card, CardList, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  role: "owner" | "editor";
}>;

type Loaded = Readonly<{ shop: ShopSettings; rewards: RewardView[] }>;

/** One labelled text box; Arabic fields read right to left, English left to right, whatever the page's language. */
function TextField({
  label,
  value,
  lang,
  multiline = false,
  invalid = false,
  change,
}: Readonly<{
  label: string;
  value: string;
  lang?: Language;
  multiline?: boolean;
  invalid?: boolean;
  change: (text: string) => void;
}>) {
  const shared = {
    value,
    "aria-invalid": invalid,
    ...(lang === undefined ? {} : { lang, dir: directionOf(lang) }),
  };
  return (
    <Field label={label}>
      {multiline ? (
        <Textarea {...shared} rows={3} maxLength={2000} onChange={(e) => change(e.target.value)} />
      ) : (
        <Input {...shared} maxLength={120} onChange={(e) => change(e.target.value)} />
      )}
    </Field>
  );
}

/** The reward form, for a new reward or an edit; the kind is chosen once. */
function RewardForm({
  language,
  terms,
  initial,
  unitsOut,
  editing,
  deskSet,
  busy,
  submit,
  cancel,
}: Readonly<{
  language: Language;
  terms: EventTerms;
  initial: RewardDraft;
  unitsOut: number;
  editing: boolean;
  /** Item rewards need the prize desk's place first (FR-1716). */
  deskSet: boolean;
  busy: boolean;
  submit: (draft: RewardDraft) => void;
  cancel: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState<RewardField | undefined>(undefined);
  const set = (change: Partial<RewardDraft>) => setDraft((current) => ({ ...current, ...change }));
  const invalid = shown;
  const needsDesk = !editing && draft.kind === "item" && !deskSet;
  const send = (event: FormEvent) => {
    event.preventDefault();
    const problem = rewardProblem(draft, unitsOut);
    setShown(problem);
    if (problem === undefined) {
      submit(draft);
    }
  };
  return (
    <Card>
      <Form onSubmit={send} aria-busy={busy}>
        <SubHeading as="h3">{t(editing ? "rewards.edit" : "rewards.add")}</SubHeading>
        {editing ? null : (
          <FieldGroup legend={t("rewards.kind")} layout="choices">
            {REWARD_KINDS.map((kind) => (
              <Radio
                key={kind}
                label={<>{t(`rewards.kind.${kind}`)}</>}
                name="reward-kind"
                checked={draft.kind === kind}
                onChange={() => set({ kind })}
              />
            ))}
          </FieldGroup>
        )}
        <FieldGroup layout="columns">
          <TextField
            label={t("rewards.nameAr")}
            lang="ar"
            value={draft.nameAr}
            invalid={invalid === "name"}
            change={(nameAr) => set({ nameAr })}
          />
          <TextField
            label={t("rewards.nameEn")}
            lang="en"
            value={draft.nameEn}
            invalid={invalid === "name"}
            change={(nameEn) => set({ nameEn })}
          />
        </FieldGroup>
        <FieldGroup layout="columns">
          <TextField
            label={t("rewards.descriptionAr")}
            lang="ar"
            multiline
            value={draft.descriptionAr}
            change={(descriptionAr) => set({ descriptionAr })}
          />
          <TextField
            label={t("rewards.descriptionEn")}
            lang="en"
            multiline
            value={draft.descriptionEn}
            change={(descriptionEn) => set({ descriptionEn })}
          />
        </FieldGroup>
        <FieldGroup layout="columns">
          <NumberField
            label={t("rewards.price", { currency: termFor(terms.currency, language) })}
            value={draft.price}
            invalid={invalid === "price"}
            change={(text) => set({ price: Number(text) })}
          />
          {draft.kind === "digital" ? null : (
            <NumberField
              label={t("rewards.stock")}
              value={draft.stock}
              invalid={invalid === "stock"}
              change={(text) => set({ stock: Number(text) })}
            />
          )}
          <NumberField
            label={t("rewards.perPlayerLimit", { player: terms.player[language].one })}
            value={draft.perPlayerLimit}
            invalid={invalid === "perPlayerLimit"}
            change={(perPlayerLimit) => set({ perPlayerLimit })}
          />
        </FieldGroup>
        {draft.kind === "digital" ? <Muted>{t("rewards.stockFromCodes")}</Muted> : null}
        {editing && unitsOut > 0 && draft.kind !== "digital" ? (
          <Muted>{t("rewards.stockFloor", { count: formatNumber(unitsOut, language) })}</Muted>
        ) : null}
        <FieldGroup layout="columns">
          <Field label={t("rewards.opensAt")}>
            <Input
              type="datetime-local"
              dir="ltr"
              value={draft.opensAt}
              onChange={(e) => set({ opensAt: e.target.value })}
            />
          </Field>
          <Field label={t("rewards.closesAt")}>
            <Input
              type="datetime-local"
              dir="ltr"
              value={draft.closesAt}
              aria-invalid={invalid === "closesAt"}
              onChange={(e) => set({ closesAt: e.target.value })}
            />
          </Field>
          <Field label={t("rewards.section")}>
            <Select
              value={draft.section}
              onChange={(e) => set({ section: e.target.value as RewardDraft["section"] })}
            >
              <option value="">{t("rewards.section.none")}</option>
              {SECTIONS.map((section) => (
                <option key={section} value={section}>
                  {t(`rewards.section.${section}`)}
                </option>
              ))}
            </Select>
          </Field>
        </FieldGroup>
        <FieldGroup layout="choiceGrid">
          <Checkbox
            label={t("rewards.tag.new")}
            checked={draft.tagNew}
            onChange={(e) => set({ tagNew: e.target.checked })}
          />
          <Checkbox
            label={t("rewards.tag.limited")}
            checked={draft.tagLimited}
            onChange={(e) => set({ tagLimited: e.target.checked })}
          />
        </FieldGroup>
        {invalid === undefined ? null : (
          <Notice tone="danger" role="alert">
            {t(`rewards.invalid.${invalid}`)}
          </Notice>
        )}
        {needsDesk ? (
          <Notice tone="danger" role="alert">
            {t("rewards.desk.needed")}
          </Notice>
        ) : null}
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy || needsDesk}>
            {t("rewards.save")}
          </Button>
        </Toolbar>
      </Form>
    </Card>
  );
}

const CONFIRM_TEXT: Readonly<Record<(typeof HANDOVER_CONFIRM)[number], MessageKey>> = {
  collect_first: "rewards.desk.confirm.collectFirst",
  desk_offer: "rewards.desk.confirm.deskOffer",
};

/**
 * The event's one prize desk (FR-1716, ADR-150): its place, an optional map pin, optional opening hours as windows in
 * the event's zone (off: open the whole time), and how players confirm a pickup in their own app (ADR-137).
 */
function DeskForm({
  language,
  initial,
  busy,
  submit,
}: Readonly<{
  language: Language;
  initial: DeskDraft;
  busy: boolean;
  submit: (desk: DeskDraft) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState<DeskField | undefined>(undefined);
  const set = (change: Partial<DeskDraft>) => setDraft((current) => ({ ...current, ...change }));
  const setWindow = (index: number, change: Partial<DeskDraft["windows"][number]>) =>
    set({ windows: draft.windows.map((w, i) => (i === index ? { ...w, ...change } : w)) });
  const send = (event: FormEvent) => {
    event.preventDefault();
    const problem = deskProblem(draft);
    setInvalid(problem);
    if (problem === undefined) {
      submit(draft);
    }
  };
  const placeSet = draft.locationAr.trim() !== "" || draft.locationEn.trim() !== "";
  return (
    <Card>
      <Form onSubmit={send} aria-busy={busy}>
        <SubHeading as="h3">{t("rewards.desk.title")}</SubHeading>
        {placeSet ? null : <Muted>{t("rewards.desk.needed")}</Muted>}
        <FieldGroup layout="columns">
          <TextField
            label={t("rewards.desk.locationAr")}
            lang="ar"
            value={draft.locationAr}
            change={(locationAr) => set({ locationAr })}
          />
          <TextField
            label={t("rewards.desk.locationEn")}
            lang="en"
            value={draft.locationEn}
            change={(locationEn) => set({ locationEn })}
          />
        </FieldGroup>
        <FieldGroup layout="columns">
          <NumberField
            label={t("rewards.desk.lat")}
            decimal
            value={draft.lat}
            invalid={invalid === "deskPin"}
            change={(lat) => set({ lat })}
          />
          <NumberField
            label={t("rewards.desk.lng")}
            decimal
            value={draft.lng}
            invalid={invalid === "deskPin"}
            change={(lng) => set({ lng })}
          />
        </FieldGroup>
        <Checkbox
          label={t("rewards.desk.hoursOn")}
          info={infoTip(t, "rewards.desk.hoursHint")}
          checked={draft.hoursOn}
          onChange={(e) =>
            set({
              hoursOn: e.target.checked,
              windows:
                e.target.checked && draft.windows.length === 0 ? [nextWindow([])] : draft.windows,
            })
          }
        />
        {draft.hoursOn ? (
          <>
            {draft.windows.map((window, index) => (
              <FieldGroup layout="columns" key={index}>
                <Field label={t("rewards.desk.opens")}>
                  <Input
                    type="datetime-local"
                    dir="ltr"
                    value={window.opensAt}
                    aria-invalid={invalid === "deskHours"}
                    onChange={(e) => setWindow(index, { opensAt: e.target.value })}
                  />
                </Field>
                <Field label={t("rewards.desk.closes")}>
                  <Input
                    type="datetime-local"
                    dir="ltr"
                    value={window.closesAt}
                    aria-invalid={invalid === "deskHours"}
                    onChange={(e) => setWindow(index, { closesAt: e.target.value })}
                  />
                </Field>
                <Button
                  variant="quiet"

                  onClick={() => set({ windows: draft.windows.filter((_, i) => i !== index) })}
                >
                  {t("rewards.desk.removeWindow")}
                </Button>
              </FieldGroup>
            ))}
            {draft.windows.length < DESK_WINDOWS ? (
              <Button
                variant="quiet"

                onClick={() => set({ windows: [...draft.windows, nextWindow(draft.windows)] })}
              >
                {t("rewards.desk.addWindow")}
              </Button>
            ) : null}
          </>
        ) : (
          <Muted>{t("rewards.desk.alwaysOpen")}</Muted>
        )}
        <FieldGroup legend={t("rewards.desk.confirm")} layout="choices">
          {HANDOVER_CONFIRM.map((confirm) => (
            <Radio
              key={confirm}
              label={t(CONFIRM_TEXT[confirm])}
              name="handover-confirm"
              checked={draft.confirm === confirm}
              onChange={() => set({ confirm })}
            />
          ))}
        </FieldGroup>
        {invalid === undefined ? null : (
          <Notice tone="danger" role="alert">
            {t(`rewards.invalid.${invalid}`)}
          </Notice>
        )}
        <Toolbar>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("rewards.desk.save")}
          </Button>
        </Toolbar>
      </Form>
    </Card>
  );
}

/**
 * The pickup time, the days the shop stays open after the end, and the shop's rules (ADR-048, ADR-049, FR-515). The
 * closing line and the days field's rule follow ADR-336 and ADR-338: after the end the days only grow, once closed they
 * are frozen. `zone` is the event's time zone and whether it has ended; the closing line waits for it, so no time is
 * read in the wrong zone.
 */
function ShopForm({
  language,
  initial,
  rankLock,
  zone,
  busy,
  submit,
}: Readonly<{
  language: Language;
  initial: ShopSettings;
  /** Why the ranking choice cannot change here, if it cannot (FR-1847). */
  rankLock: "locked" | "ownerOnly" | undefined;
  zone: Readonly<{ timezone: string; ended: boolean }> | undefined;
  busy: boolean;
  submit: (shop: ShopSettings) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState<ShopField | undefined>(undefined);
  const rule = daysRule(initial, zone?.ended ?? false);
  const send = (event: FormEvent) => {
    event.preventDefault();
    const problem = shopDraftProblem(draft, initial, rule);
    setInvalid(problem);
    if (problem === undefined) {
      submit(draft);
    }
  };
  return (
    <Card>
      <Form onSubmit={send} aria-busy={busy}>
        <SubHeading as="h3">{t("rewards.shop")}</SubHeading>
        <FieldGroup layout="columns">
          <NumberField
            label={t("rewards.pickupMinutes")}
            value={draft.pickupMinutes}
            invalid={invalid === "pickupMinutes"}
            change={(text) => setDraft({ ...draft, pickupMinutes: Number(text) })}
          />
          <NumberField
            label={t("rewards.daysAfter")}
            value={draft.daysAfter}
            invalid={daysFieldInvalid(invalid)}
            disabled={rule === "frozen"}
            change={(text) => setDraft({ ...draft, daysAfter: Number(text) })}
          />
        </FieldGroup>
        <ShopWindowNotes language={language} shop={initial} rule={rule} timezone={zone?.timezone} />
        <FieldGroup layout="columns">
          <TextField
            label={t("rewards.rulesAr")}
            lang="ar"
            multiline
            value={draft.rules.ar ?? ""}
            change={(ar) => setDraft({ ...draft, rules: { ...draft.rules, ar } })}
          />
          <TextField
            label={t("rewards.rulesEn")}
            lang="en"
            multiline
            value={draft.rules.en ?? ""}
            change={(en) => setDraft({ ...draft, rules: { ...draft.rules, en } })}
          />
        </FieldGroup>
        <Checkbox
          label={t("rewards.spendLowersRank")}
          checked={draft.spendLowersRank}
          info={
            <InfoTip label={t("common.info")}>
              {t("rewards.spendLowersRank.hint")}
              {rankLock === undefined ? null : ` ${t(`rewards.spendLowersRank.${rankLock}`)}`}
            </InfoTip>
          }
          disabled={rankLock !== undefined}
          onChange={(e) => setDraft({ ...draft, spendLowersRank: e.target.checked })}
        />
        {invalid === undefined ? null : (
          <Notice tone="danger" role="alert">
            {t(`rewards.invalid.${invalid}`)}
          </Notice>
        )}
        <Toolbar>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("rewards.saveShop")}
          </Button>
        </Toolbar>
      </Form>
    </Card>
  );
}

/** The shop settings form for the loaded shop and event: it starts over when the window or the ranking lock moves. */
function ShopSection({
  language,
  shop,
  rankLock,
  event,
  busy,
  save,
}: Readonly<{
  language: Language;
  shop: ShopSettings;
  rankLock: "locked" | "ownerOnly" | undefined;
  event: Readonly<{ timezone: string; statusNow: string }> | undefined;
  busy: boolean;
  /** Sends the body of `PUT …/shop`. */
  save: (body: Record<string, unknown>) => void;
}>) {
  const ended = event?.statusNow === "ended" || event?.statusNow === "archived";
  return (
    <ShopForm
      key={`${rankLock ?? "open"}:${shop.state}:${shop.daysAfter}`}
      language={language}
      initial={shop}
      rankLock={rankLock}
      zone={event === undefined ? undefined : { timezone: event.timezone, ended }}
      busy={busy}
      submit={(draft) => save(shopRequest(draft, shop))}
    />
  );
}

/** When the shop closes, what the days field may do, and the warning when the desk's hours end first. */
function ShopWindowNotes({
  language,
  shop,
  rule,
  timezone,
}: Readonly<{
  language: Language;
  shop: ShopSettings;
  rule: DaysRule;
  timezone: string | undefined;
}>) {
  const t = translatorFor(language);
  return (
    <>
      {shop.closesAt === null || timezone === undefined ? null : (
        <Muted>
          {t(shop.state === "closed" ? "rewards.shopClosed" : "rewards.shopCloses", {
            date: formatEventTime(new Date(shop.closesAt), timezone, language),
          })}
        </Muted>
      )}
      {rule === "free" ? null : (
        <Muted>
          {t(rule === "frozen" ? "rewards.daysAfter.closed" : "rewards.daysAfter.afterEnd")}
        </Muted>
      )}
      {deskEndsBeforeClose(shop) ? (
        <Notice tone="warning">{t("rewards.deskEndsEarly")}</Notice>
      ) : null}
    </>
  );
}

function RewardRow({
  language,
  reward,
  terms,
  busy,
  edit,
  remove,
  upload,
}: Readonly<{
  language: Language;
  reward: RewardView;
  terms: EventTerms;
  busy: boolean;
  edit: () => void;
  remove: () => void;
  upload: (codes: string[]) => Promise<boolean>;
}>) {
  const t = translatorFor(language);
  const [confirming, setConfirming] = useState(false);
  const name = reward.name[language] ?? reward.name[language === "ar" ? "en" : "ar"] ?? "";
  return (
    <Card as="li">
      <Toolbar>
        <strong>{name}</strong>
        <Badge>{t(`rewards.kind.${reward.kind}`)}</Badge>
        <SponsorBadge language={language} kind="reward" targetId={reward.id} />
      </Toolbar>
      <Toolbar>
        <span>
          {t("rewards.priceShort", {
            points: formatNumber(reward.price, language),
            currency: termFor(terms.currency, language),
          })}
        </span>
        <span>
          {reward.stockLeft === 0
            ? t("rewards.soldOut")
            : t("rewards.left", {
                left: formatNumber(reward.stockLeft, language),
                stock: formatNumber(reward.stock, language),
              })}
        </span>
        {reward.unitsOut > 0 ? (
          <Muted as="span">
            {t(reward.kind === "digital" ? "rewards.redeemed" : "rewards.reserved", {
              count: formatNumber(reward.unitsOut, language),
            })}
          </Muted>
        ) : null}
      </Toolbar>
      {reward.kind === "digital" ? (
        <CodesForm language={language} busy={busy} upload={upload} />
      ) : null}
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={edit}>
          {t("rewards.edit")}
        </Button>
        {confirming ? (
          <>
            <span role="alert">{t("rewards.removeConfirm")}</span>
            <Button
              variant="quiet"

              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={remove}>
              {t("rewards.remove")}
            </Button>
          </>
        ) : (
          <Button
            variant="quiet"

            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("rewards.remove")}
          </Button>
        )}
      </Toolbar>
    </Card>
  );
}

/** Adds a digital reward's codes (FR-510): pasted, one per line, or read from a text or CSV file in the browser. */
function CodesForm({
  language,
  busy,
  upload,
}: Readonly<{ language: Language; busy: boolean; upload: (codes: string[]) => Promise<boolean> }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState<CodesProblem | undefined>(undefined);
  if (!open) {
    return (
      <Toolbar>
        <Button
          variant="quiet"

          disabled={busy}
          onClick={() => setOpen(true)}
        >
          {t("rewards.codes.add")}
        </Button>
      </Toolbar>
    );
  }
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseCodes(text);
    if ("problem" in parsed) {
      setInvalid(parsed.problem);
      return;
    }
    setInvalid(undefined);
    if (await upload(parsed.codes)) {
      setText("");
      setOpen(false);
    }
  };
  return (
    <Card>
      <Form onSubmit={(e) => void send(e)} aria-busy={busy}>
        <Field label={t("rewards.codes.label")}>
          <Textarea
            dir="ltr"
            rows={6}
            value={text}
            aria-invalid={invalid !== undefined}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Field label={t("rewards.codes.file")}>
          <Input
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) {
                void file
                  .text()
                  .then((read) =>
                    setText(file.name.toLowerCase().endsWith(".csv") ? firstColumn(read) : read),
                  );
              }
            }}
          />
        </Field>
        <Muted>{t("rewards.codes.private")}</Muted>
        {invalid === undefined ? null : (
          <Notice tone="danger" role="alert">
            {t(`rewards.codes.invalid.${invalid}`)}
          </Notice>
        )}
        <Toolbar>
          <Button
            variant="quiet"

            disabled={busy}
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {t("rewards.codes.save")}
          </Button>
        </Toolbar>
      </Form>
    </Card>
  );
}

/** The digital rewards whose codes run low, named with what is left (FR-512); nothing when none is. */
function LowCodes({ language, rewards }: Readonly<{ language: Language; rewards: RewardView[] }>) {
  const t = translatorFor(language);
  const low = lowCodeRewards(rewards);
  if (low.length === 0) {
    return null;
  }
  return (
    <Notice as="div" tone="warning" role="note" labelledBy="low-codes-title">
      <p id="low-codes-title">
        <strong>{t("rewards.lowCodes.title")}</strong>
      </p>
      <ul>
        {low.map((reward) => (
          <li key={reward.id}>
            {t("rewards.lowCodes.item", {
              name: reward.name[language] ?? reward.name[language === "ar" ? "en" : "ar"] ?? "",
              left: formatNumber(reward.stockLeft, language),
            })}
          </li>
        ))}
      </ul>
      <Muted>{t("rewards.lowCodes.hint")}</Muted>
    </Notice>
  );
}

type Editing =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "edit"; reward: RewardView }>
  | undefined;

/**
 * An event's rewards shop on the dashboard (T-201: FR-504, FR-505, FR-514, FR-516): the rewards with their stock, a
 * form to add or change one, removal with a confirmation, and the shop settings. Every answer refreshes the list.
 */
export function RewardsPanel({ language, organizerId, eventId, role }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  // Until the event arrives its zone is unknown: adding or editing waits, so no time is read in the wrong zone.
  const [event, setEvent] = useState<
    { timezone: string; terms: EventTerms; statusNow: string } | undefined
  >(undefined);
  const terms = event?.terms ?? DEFAULT_TERMS;
  const [editing, setEditing] = useState<Editing>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const started = useRef(false);

  const failed = useCallback(
    (result: PostResult): boolean => {
      if (result.ok) {
        return false;
      }
      if (SESSION_LOST.has(errorCodeOf(result.body) ?? "")) {
        window.location.assign(`/${language}/sign-in`);
        return true;
      }
      setProblem(describeProblem(result.body, language, t).text);
      return true;
    },
    [language, t],
  );

  const load = useCallback(async () => {
    const result = await requestJson("GET", `${base}/rewards`);
    if (!failed(result)) {
      setLoaded(result.body as Loaded);
    }
  }, [base, failed]);

  useEffect(() => {
    // Once per page, also under Strict Mode's double effect.
    if (started.current) {
      return;
    }
    started.current = true;
    void load();
    void requestJson("GET", base).then((result) => {
      if (result.ok) {
        const view = (
          result.body as { event: { timezone: string; terms?: unknown; statusNow: string } }
        ).event;
        setEvent({
          timezone: view.timezone,
          terms: readEventTerms(view.terms),
          statusNow: view.statusNow,
        });
      }
    });
  }, [base, load]);

  const run = async (
    work: () => Promise<PostResult>,
    done: MessageKey | ((body: unknown) => string),
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await work();
    const ok = !failed(result);
    if (ok) {
      setEditing(undefined);
      setNotice(typeof done === "function" ? done(result.body) : t(done));
      await load();
    } else if (errorCodeOf(result.body) === "shop_window_locked") {
      // The page was stale (a co-editor lengthened the window, or it closed): show the real closing date.
      await load();
    }
    setBusy(false);
    return ok;
  };

  const rankLock =
    role !== "owner"
      ? ("ownerOnly" as const)
      : event === undefined || (event.statusNow !== "draft" && event.statusNow !== "scheduled")
        ? ("locked" as const)
        : undefined;

  const save = (draft: RewardDraft) =>
    editing?.kind === "edit"
      ? run(
          () =>
            requestJson(
              "PATCH",
              `${base}/rewards/${editing.reward.id}`,
              editRewardBody(
                draft,
                rewardDraftOf(editing.reward, event?.timezone ?? "Asia/Riyadh"),
              ),
            ),
          "rewards.saved",
        )
      : run(
          () =>
            requestJson("POST", `${base}/rewards`, createRewardBody(draft), {
              "idempotency-key": crypto.randomUUID(),
            }),
          "rewards.saved",
        );

  return (
    <Stack as="section" aria-labelledby="rewards-title">
      <PageHeader titleId="rewards-title" title={t("rewards.title")} />
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
      {loaded === undefined && problem !== null ? (
        <Button variant="quiet" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      ) : null}
      {loaded === undefined ? (
        problem === null ? (
          <Muted>{t("common.loading")}</Muted>
        ) : null
      ) : (
        <>
          {event === undefined ? null : (
            <DeskForm
              key={JSON.stringify(loaded.shop.desk) + loaded.shop.handoverConfirm}
              language={language}
              initial={deskDraftOf(loaded.shop, event.timezone)}
              busy={busy}
              submit={(desk) =>
                void run(
                  () => requestJson("PUT", `${base}/shop`, deskRequest(desk)),
                  "rewards.desk.saved",
                )
              }
            />
          )}
          {editing === undefined ? (
            <Toolbar>
              <Button
                variant="primary"
                disabled={event === undefined}
                onClick={() => setEditing({ kind: "new" })}
              >
                {t("rewards.add")}
              </Button>
            </Toolbar>
          ) : (
            <RewardForm
              key={editing.kind === "edit" ? editing.reward.id : "new"}
              language={language}
              terms={terms}
              initial={
                editing.kind === "edit"
                  ? rewardDraftOf(editing.reward, event?.timezone ?? "Asia/Riyadh")
                  : blankReward()
              }
              unitsOut={editing.kind === "edit" ? editing.reward.unitsOut : 0}
              editing={editing.kind === "edit"}
              deskSet={deskIsSet(loaded.shop.desk)}
              busy={busy}
              submit={(draft) => void save(draft)}
              cancel={() => setEditing(undefined)}
            />
          )}
          <LowCodes language={language} rewards={loaded.rewards} />
          {loaded.rewards.length === 0 ? <EmptyState>{t("rewards.none")}</EmptyState> : null}
          <CardList>
            {loaded.rewards.map((reward) => (
              <RewardRow
                key={reward.id}
                language={language}
                reward={reward}
                terms={terms}
                busy={busy || event === undefined}
                edit={() => setEditing({ kind: "edit", reward })}
                remove={() =>
                  void run(
                    () => requestJson("DELETE", `${base}/rewards/${reward.id}`),
                    "rewards.removed",
                  )
                }
                upload={(codes) =>
                  run(
                    () =>
                      requestJson(
                        "POST",
                        `${base}/rewards/${reward.id}/codes`,
                        { codes },
                        { "idempotency-key": crypto.randomUUID() },
                      ),
                    (body) => {
                      const counts = body as { added: number; duplicates: number };
                      return t("rewards.codes.added", {
                        added: formatNumber(counts.added, language),
                        duplicates: formatNumber(counts.duplicates, language),
                      });
                    },
                  )
                }
              />
            ))}
          </CardList>
          <ShopSection
            language={language}
            shop={loaded.shop}
            rankLock={rankLock}
            event={event}
            busy={busy}
            save={(body) =>
              void run(() => requestJson("PUT", `${base}/shop`, body), "rewards.shopSaved")
            }
          />
        </>
      )}
    </Stack>
  );
}
