"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState, type FormEvent } from "react";
import { keyed, Problem } from "#src/components/ConsoleOversight.tsx";
import { MODERATION_ADDRESSES_API } from "#src/lib/console-reports.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { Section } from "#src/ui/Section.tsx";

type Addresses = Readonly<{
  alertEmail: string | null;
  appealEmail: string | null;
  sendingAddress: string;
}>;

function readAddresses(body: unknown): Addresses | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = body as Record<string, unknown>;
  const optional = (one: unknown) => (typeof one === "string" ? one : null);
  return typeof value["sendingAddress"] === "string"
    ? {
        alertEmail: optional(value["alertEmail"]),
        appealEmail: optional(value["appealEmail"]),
        sendingAddress: value["sendingAddress"],
      }
    : undefined;
}

/**
 * The Reports page's Moderation addresses card (T-701b, ADR-495): where urgent-report alerts go and the address a
 * banned player appeals to; an empty field means the sending address. Saved through one audited door.
 */
export function ModerationAddresses({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [saved, setSaved] = useState<Addresses | null>(null);
  const [alert, setAlert] = useState("");
  const [appeal, setAppeal] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const show = (addresses: Addresses) => {
    setSaved(addresses);
    setAlert(addresses.alertEmail ?? "");
    setAppeal(addresses.appealEmail ?? "");
  };
  useEffect(() => {
    void requestJson("GET", MODERATION_ADDRESSES_API).then((result) => {
      const read = result.ok ? readAddresses(result.body) : undefined;
      if (read !== undefined) show(read);
    });
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setDone(false);
    const result = await requestJson(
      "PUT",
      MODERATION_ADDRESSES_API,
      { alertEmail: alert.trim() || null, appealEmail: appeal.trim() || null },
      keyed(),
    );
    setBusy(false);
    const read = result.ok ? readAddresses(result.body) : undefined;
    if (read === undefined) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setProblem(null);
    setDone(true);
    show(read);
  };
  if (saved === null) return null;
  const help = t("console.modAddresses.fallback", { email: saved.sendingAddress });
  return (
    <Section title={t("console.modAddresses.title")} level={2}>
      <Form onSubmit={(event) => void submit(event)}>
        <Field label={t("console.modAddresses.alert")} help={help}>
          <Input type="email" dir="ltr" value={alert} onChange={(e) => setAlert(e.target.value)} />
        </Field>
        <Field label={t("console.modAddresses.appeal")} help={help}>
          <Input type="email" dir="ltr" value={appeal} onChange={(e) => setAppeal(e.target.value)} />
        </Field>
        <Problem problem={problem} />
        {done ? (
          <Notice tone="success" role="status">
            {t("console.modAddresses.saved")}
          </Notice>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {t("console.modAddresses.save")}
        </Button>
      </Form>
    </Section>
  );
}
