"use client";

import { surveyShareStateSchema, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { surveyLinkOf } from "#src/lib/survey-links.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { FieldGroup, Input } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Section } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Share = Readonly<{
  /** Whether the quest has a link; null until the first read. */
  shared: boolean | null;
  /** The link just made, shown once; null otherwise. */
  link: string | null;
  copied: boolean;
  busy: boolean;
  stopped: boolean;
  problem: string | null;
  make: () => void;
  stop: () => void;
  copy: () => void;
}>;

/** The share state of one survey quest and the three things a team member does with it. */
function useSurveyShare(language: Language, url: string, t: Translate): Share {
  const [shared, setShared] = useState<boolean | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    let live = true;
    void requestJson("GET", url).then((result) => {
      const parsed = result.ok ? surveyShareStateSchema.safeParse(result.body) : null;
      if (live && parsed?.success === true) setShared(parsed.data.shared);
    });
    return () => {
      live = false;
    };
  }, [url]);

  const fail = (body: unknown) => setProblem(describeProblem(body, language, t).text);
  const make = async () => {
    setBusy(true);
    setProblem(null);
    setStopped(false);
    const result = await requestJson("POST", url, {});
    setBusy(false);
    const token = (result.body as { token?: unknown } | undefined)?.token;
    if (!result.ok || typeof token !== "string") return fail(result.body);
    setLink(surveyLinkOf(window.location.origin, language, token));
    setCopied(false);
    setShared(true);
  };
  const stop = async () => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson("DELETE", url);
    setBusy(false);
    if (!result.ok) return fail(result.body);
    setLink(null);
    setShared(false);
    setStopped(true);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link ?? "");
      setCopied(true);
    } catch {
      setProblem(t("surveyResults.share.failed"));
    }
  };
  return {
    shared,
    link,
    copied,
    busy,
    stopped,
    problem,
    make: () => void make(),
    stop: () => void stop(),
    copy: () => void copy(),
  };
}

/** The link just made, with its copy button; nothing once the page has moved on. */
function ShareLink({ share, t }: Readonly<{ share: Share; t: Translate }>) {
  if (share.link === null) return null;
  return (
    <FieldGroup>
      <Muted>{t("surveyResults.share.once")}</Muted>
      <Input dir="ltr" readOnly value={share.link} aria-label={t("surveyResults.share.link")} />
      <IconButton icon="copy" label={t("surveyResults.share.copy")} onClick={share.copy} />
      {share.copied ? (
        <Notice tone="success" role="status">
          {t("surveyResults.share.copied")}
        </Notice>
      ) : null}
    </FieldGroup>
  );
}

/**
 * The speaker's link for one survey quest (FR-1210, ADR-376 (5)): make a link, copy it, make a new one that replaces it,
 * or stop sharing. The link is shown once, when it is made; only a hash of it is stored.
 */
export function SurveyShare({ language, url }: Readonly<{ language: Language; url: string }>) {
  const t = translatorFor(language);
  const share = useSurveyShare(language, url, t);
  if (share.shared === null) return null;
  return (
    <Section
      level={3}
      title={t("surveyResults.share.title")}
      info={infoTip(t, "surveyResults.share.info")}
      actions={
        <>
          <Button variant="quiet" disabled={share.busy} onClick={share.make}>
            {t(share.shared ? "surveyResults.share.replace" : "surveyResults.share.create")}
          </Button>
          {share.shared ? (
            <Button variant="quiet" disabled={share.busy} onClick={share.stop}>
              {t("surveyResults.share.stop")}
            </Button>
          ) : null}
        </>
      }
    >
      <Muted role="status">
        {t(share.shared ? "surveyResults.share.active" : "surveyResults.share.off")}
        {share.stopped ? ` ${t("surveyResults.share.stopped")}` : ""}
      </Muted>
      <ShareLink share={share} t={t} />
      {share.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {share.problem}
        </Notice>
      )}
    </Section>
  );
}
