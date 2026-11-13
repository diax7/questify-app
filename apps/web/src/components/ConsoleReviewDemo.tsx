"use client";

import {
  REVIEW_WINDOW_DAYS,
  formatNumber,
  type Language,
  type ReviewDemoView,
} from "@questify/shared";
import { useState } from "react";
import { CatalogState } from "#src/components/CatalogParts.tsx";
import { ConfirmedButton, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import styles from "#src/components/catalog.module.css";
import { nameIn } from "#src/lib/console.ts";
import { clockOf } from "#src/lib/console-organizers.ts";
import {
  CHECKLIST_GROUPS,
  REVIEW_DEMO_API,
  REVIEW_DEMO_CLOSE_API,
  REVIEW_DEMO_CONTACT_API,
  REVIEW_DEMO_PREPARE_API,
  itemKeyOf,
  prepareBody,
  readPrepared,
  readReviewDemo,
} from "#src/lib/console-review-demo.ts";
import { isolate, translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button, ButtonLink } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { FactList, Section, Stack, Toolbar } from "#src/ui/Section.tsx";

type Ready = ReviewDemoView & { exists: true };
type Write = ReturnType<typeof useWrite>;

/** The reviewer phone field and its button: Create before the demo exists, Change reviewer number after. */
function PhoneForm({
  language,
  write,
  exists,
}: Readonly<{ language: Language; write: Write; exists: boolean }>) {
  const t = translatorFor(language);
  const [phone, setPhone] = useState("");
  const send = () =>
    void write.run(
      () =>
        requestJson(
          exists ? "PUT" : "POST",
          exists ? REVIEW_DEMO_CONTACT_API : REVIEW_DEMO_API,
          { phone },
          keyed(),
        ),
      t(exists ? "console.reviewDemo.numberChanged" : "console.reviewDemo.created"),
    );
  return (
    <Stack>
      <Field label={t("console.reviewDemo.phone")}>
        <Input
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          placeholder="05XXXXXXXX"
          value={phone}
          disabled={write.busy}
          data-field="phone"
          onChange={(event) => setPhone(event.target.value)}
        />
      </Field>
      {exists ? (
        <ConfirmedButton
          language={language}
          label={t("console.reviewDemo.changeNumber")}
          question={t("console.reviewDemo.changeAsk")}
          variant="secondary"
          disabled={write.busy || phone.trim() === ""}
          act={send}
        />
      ) : (
        <Toolbar>
          <Button disabled={write.busy || phone.trim() === ""} onClick={send}>
            {t("console.reviewDemo.create")}
          </Button>
        </Toolbar>
      )}
    </Stack>
  );
}

/** The new fixed code, shown once with Copy and the warning to paste it now. */
function CodeShownOnce({ language, code }: Readonly<{ language: Language; code: string }>) {
  const t = translatorFor(language);
  const [copied, setCopied] = useState(false);
  return (
    <Notice tone="warning" as="div" role="alert">
      <p>{t("console.reviewDemo.code")}</p>
      <p dir="ltr" data-testid="review-code" className={styles.name}>
        {code}
      </p>
      <p>{t("console.reviewDemo.codeOnce")}</p>
      <Toolbar>
        <Button
          size="sm"
          onClick={() => void navigator.clipboard.writeText(code).then(() => setCopied(true))}
        >
          {t("console.reviewDemo.copy")}
        </Button>
        {copied ? <Muted role="status">{t("console.reviewDemo.copied")}</Muted> : null}
      </Toolbar>
    </Notice>
  );
}

/** Prepare for review: the version and the window's days; the answer's code goes to `shown`. */
function PrepareForm({
  language,
  write,
  shown,
}: Readonly<{ language: Language; write: Write; shown: (code: string) => void }>) {
  const t = translatorFor(language);
  const [version, setVersion] = useState("");
  const [days, setDays] = useState(String(REVIEW_WINDOW_DAYS.default));
  const body = prepareBody(days, version);
  const prepare = () =>
    void write.run(async () => {
      const result = await requestJson("POST", REVIEW_DEMO_PREPARE_API, body);
      const prepared = result.ok ? readPrepared(result.body) : undefined;
      if (prepared !== undefined) {
        shown(prepared.code);
      }
      return result;
    }, t("console.reviewDemo.prepared"));
  return (
    <Stack>
      <Field label={t("console.reviewDemo.version")}>
        <Input
          dir="ltr"
          placeholder="1.4.0"
          value={version}
          disabled={write.busy}
          data-field="version"
          onChange={(event) => setVersion(event.target.value)}
        />
      </Field>
      <Field label={t("console.reviewDemo.days")}>
        <Input
          type="number"
          min={REVIEW_WINDOW_DAYS.min}
          max={REVIEW_WINDOW_DAYS.max}
          value={days}
          disabled={write.busy}
          data-field="days"
          onChange={(event) => setDays(event.target.value)}
        />
      </Field>
      <ConfirmedButton
        language={language}
        label={t("console.reviewDemo.prepare")}
        question={t("console.reviewDemo.prepareAsk")}
        variant="primary"
        disabled={write.busy || body === undefined}
        act={prepare}
      />
    </Stack>
  );
}

/** The event, the reviewer account and the window, as the database holds them now. */
function StateFacts({ language, demo }: Readonly<{ language: Language; demo: Ready }>) {
  const t = translatorFor(language);
  const reviewer = demo.reviewer;
  const lastSignIn =
    reviewer?.lastSignInAt === null || reviewer === null
      ? t("console.reviewDemo.neverSignedIn")
      : t("console.reviewDemo.lastSignIn", { when: clockOf(reviewer.lastSignInAt, language) });
  return (
    <Stack>
      <FactList label={t("console.reviewDemo.event")}>
        <span dir="auto">{nameIn(demo.eventName, language)}</span>
        <span>{t("console.reviewDemo.joinCode", { code: isolate(demo.joinCode) })}</span>
        <span>{t("console.reviewDemo.endsAt", { when: clockOf(demo.endsAt, language) })}</span>
        <span>
          {t("console.reviewDemo.fictional", {
            count: formatNumber(demo.fictionalPlayers, language),
          })}
        </span>
      </FactList>
      <Toolbar>
        <ButtonLink variant="quiet" size="sm" href={`/${language}/console/events/${demo.eventId}`}>
          {t("console.reviewDemo.openEvent")}
        </ButtonLink>
      </Toolbar>
      <FactList label={t("console.reviewDemo.reviewer")}>
        {reviewer === null ? (
          <span>{t("console.reviewDemo.noReviewer")}</span>
        ) : (
          <span dir="auto">{reviewer.username}</span>
        )}
        <span>{lastSignIn}</span>
        <span dir="ltr">{demo.contact}</span>
      </FactList>
      <FactList label={t("console.reviewDemo.window")}>
        <span data-testid="review-window">
          {demo.windowUntil === null
            ? t("console.reviewDemo.windowClosed")
            : t("console.reviewDemo.windowOpen", {
                when: clockOf(demo.windowUntil, language),
                version: demo.preparedFor ?? "",
              })}
        </span>
      </FactList>
    </Stack>
  );
}

/** Every quest type, verification and review-day item, present or missing in the demo event (ADR-568). */
function Checklist({ language, demo }: Readonly<{ language: Language; demo: Ready }>) {
  const t = translatorFor(language);
  return (
    <Section title={t("console.reviewDemo.readiness")} level={3}>
      {CHECKLIST_GROUPS.map((group) => (
        <FactList key={group.kind} label={t(group.title)}>
          {demo.checklist
            .filter((item) => item.kind === group.kind)
            .map((item) => {
              const key = itemKeyOf(item);
              return (
                <span key={item.key} data-testid="readiness-item" data-present={item.present}>
                  {key === undefined ? item.key : t(key)}{" "}
                  <Badge tone={item.present ? "success" : "neutral"}>
                    {t(item.present ? "console.reviewDemo.present" : "console.reviewDemo.missing")}
                  </Badge>
                </span>
              );
            })}
        </FactList>
      ))}
    </Section>
  );
}

/**
 * The console's App Review demo (T-710, FR-1406, FR-1407, FR-1736): Create once with the reviewer phone; then the event,
 * the reviewer account and the window, Prepare for review (the new fixed code shown once), Close window, Change
 * reviewer number, and the readiness checklist. Platform admins only; every action is audited by the database.
 */
export function ConsoleReviewDemo({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(REVIEW_DEMO_API, readReviewDemo);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const write = useWrite(language, (done) => {
    setNotice(done);
    void reload();
  });
  return (
    <Section title={t("console.reviewDemo.title")}>
      <CatalogState language={language} catalog={{ state, reload, notice, problem: write.problem }}>
        {(demo) =>
          demo.exists ? (
            <Stack>
              {code === null ? null : <CodeShownOnce language={language} code={code} />}
              <StateFacts language={language} demo={demo} />
              <PrepareForm language={language} write={write} shown={setCode} />
              <ConfirmedButton
                language={language}
                label={t("console.reviewDemo.close")}
                question={t("console.reviewDemo.closeAsk")}
                variant="danger"
                disabled={write.busy || demo.windowUntil === null}
                act={() =>
                  void write.run(
                    () => requestJson("POST", REVIEW_DEMO_CLOSE_API, {}, keyed()),
                    t("console.reviewDemo.closed"),
                  )
                }
              />
              <PhoneForm language={language} write={write} exists />
              <Checklist language={language} demo={demo} />
            </Stack>
          ) : (
            <Stack>
              <Muted role="status">{t("console.reviewDemo.none")}</Muted>
              <PhoneForm language={language} write={write} exists={false} />
            </Stack>
          )
        }
      </CatalogState>
    </Section>
  );
}
