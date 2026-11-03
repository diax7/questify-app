"use client";

import type { Language, MessageKey } from "@questify/shared";
import { useState } from "react";
import {
  ConfirmedButton,
  keyed,
  Problem,
  ReasonField,
  reasonReady,
  useWrite,
} from "#src/components/ConsoleOversight.tsx";
import { clockOf, type OwnerEmailChange } from "#src/lib/console-organizers.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";
import { Section, Stack } from "#src/ui/Section.tsx";

const IDENTITY_CHECKS = ["known_phone", "id_document", "contract_contact", "other"] as const;
/** The words of each identity check and each closed state (message keys are camel case, the API's codes snake case). */
const IDENTITY_KEYS = {
  known_phone: "console.ownerEmail.identity.knownPhone",
  id_document: "console.ownerEmail.identity.idDocument",
  contract_contact: "console.ownerEmail.identity.contractContact",
  other: "console.ownerEmail.identity.other",
} as const satisfies Record<(typeof IDENTITY_CHECKS)[number], MessageKey>;
const CLOSED_KEYS: Readonly<Record<string, MessageKey>> = {
  confirmed: "console.ownerEmail.last.confirmed",
  cancelled: "console.ownerEmail.last.cancelled",
  stopped: "console.ownerEmail.last.stopped",
  expired: "console.ownerEmail.last.expired",
  send_failed: "console.ownerEmail.last.sendFailed",
  email_taken: "console.ownerEmail.last.emailTaken",
};
const OPEN = new Set(["pending", "held"]);
const CHANGES_API = "/v1/admin/owner-email-changes";

type Props = Readonly<{
  language: Language;
  organizerId: string;
  change: OwnerEmailChange | null;
  others: readonly string[];
  onChanged: (done: string) => void;
}>;

/** What the owner card says about the open change, or about the last one. */
function ChangeStatus({
  language,
  change,
}: Readonly<{ language: Language; change: OwnerEmailChange }>) {
  const t = translatorFor(language);
  const email = change.newEmail ?? "";
  const line =
    change.state === "pending"
      ? t("console.ownerEmail.pending", { email, time: clockOf(change.expiresAt, language) })
      : change.state === "held"
        ? t("console.ownerEmail.held", { email, time: clockOf(change.appliesAt ?? "", language) })
        : t(CLOSED_KEYS[change.state] ?? "console.ownerEmail.last.cancelled", {
            email,
            time: clockOf(change.closedAt ?? change.expiresAt, language),
          });
  return (
    <>
      <Muted dir="auto">{line}</Muted>
      {change.disputedAt === null ? null : (
        <Notice tone="danger" role="alert">
          {t("console.ownerEmail.disputed")}
        </Notice>
      )}
    </>
  );
}

/** Resend the code (a pending change) and cancel (pending or held), each audited. */
function OpenChangeActions({
  language,
  change,
  onChanged,
}: Omit<Props, "organizerId" | "others"> & {
  change: OwnerEmailChange;
}) {
  const t = translatorFor(language);
  const { busy, problem, run } = useWrite(language, onChanged);
  const path = `${CHANGES_API}/${change.id}`;
  return (
    <>
      <Problem problem={problem} />
      {change.state === "pending" ? (
        <ConfirmedButton
          language={language}
          label={t("console.ownerEmail.resend")}
          question={t("console.ownerEmail.resend")}
          variant="secondary"
          disabled={busy}
          act={() =>
            void run(
              () => requestJson("POST", `${path}/resend`, { lang: language }, keyed()),
              t("console.ownerEmail.resent"),
            )
          }
        />
      ) : null}
      <ConfirmedButton
        language={language}
        label={t("console.ownerEmail.cancel")}
        question={t("console.ownerEmail.cancelConfirm")}
        variant="danger"
        disabled={busy}
        act={() =>
          void run(
            () => requestJson("POST", `${path}/cancel`, {}, keyed()),
            t("console.ownerEmail.cancelled"),
          )
        }
      />
    </>
  );
}

/** The start form: the new address, how identity was checked and a reason, then a confirmation naming every organizer. */
function StartForm({ language, organizerId, others, onChanged }: Props) {
  const t = translatorFor(language);
  const [email, setEmail] = useState("");
  const [identity, setIdentity] = useState<(typeof IDENTITY_CHECKS)[number]>("known_phone");
  const [reason, setReason] = useState("");
  const { busy, problem, run } = useWrite(language, onChanged);
  const ready = email.includes("@") && reasonReady(reason);
  const organizers = others.length === 0 ? t("console.ownerEmail.noOther") : others.join("، ");
  return (
    <>
      <Field label={t("console.ownerEmail.newEmail")}>
        <Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label={t("console.ownerEmail.identity")}>
        <Select
          value={identity}
          onChange={(e) => setIdentity(e.target.value as (typeof IDENTITY_CHECKS)[number])}
        >
          {IDENTITY_CHECKS.map((one) => (
            <option key={one} value={one}>
              {t(IDENTITY_KEYS[one])}
            </option>
          ))}
        </Select>
      </Field>
      <ReasonField
        language={language}
        label="console.ownerEmail.reason"
        reason={reason}
        change={setReason}
      />
      <Problem problem={problem} />
      <ConfirmedButton
        language={language}
        label={t("console.ownerEmail.start")}
        question={t("console.ownerEmail.confirm", { email: email.trim(), organizers })}
        variant="danger"
        disabled={busy || !ready}
        act={() =>
          void run(
            () =>
              requestJson(
                "POST",
                `/v1/admin/organizers/${organizerId}/owner-email`,
                {
                  newEmail: email.trim(),
                  identityCheck: identity,
                  reason: reason.trim(),
                  lang: language,
                },
                keyed(),
              ),
            t("console.ownerEmail.started"),
          ).then((sent) => {
            if (sent) {
              setEmail("");
              setReason("");
            }
          })
        }
      />
    </>
  );
}

/**
 * The owner card's sign-in email change (T-701b, FR-1784, ADR-490): start it after checking identity, then follow it
 * (pending, held, or how the last one ended) with Resend and Cancel. The owner confirms from the new mailbox; the admin
 * never sees the code.
 */
export function OwnerEmailPanel(props: Props) {
  const t = translatorFor(props.language);
  const { change } = props;
  const open = change !== null && OPEN.has(change.state);
  return (
    <Section title={t("console.ownerEmail.title")} level={3}>
      <Stack>
        {change === null ? null : <ChangeStatus language={props.language} change={change} />}
        {open ? (
          <OpenChangeActions
            language={props.language}
            change={change}
            onChanged={props.onChanged}
          />
        ) : (
          <StartForm {...props} />
        )}
      </Stack>
    </Section>
  );
}
