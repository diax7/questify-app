"use client";

import type { Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { qrDrawing, qrSvgFile } from "#src/lib/qr.ts";
import { textFor } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import codeStyles from "#src/components/codes.module.css";
import styles from "#src/components/layout.module.css";

type Code = Readonly<{
  questId: string;
  category: Readonly<{ ar: string | null; en: string | null }>;
  title: Readonly<{ ar: string | null; en: string | null }>;
  version: number;
  url: string;
}>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The code itself: an SVG path drawn from the data, black on white, never mirrored right to left. */
function QrImage({ text, label }: Readonly<{ text: string; label: string }>) {
  const { size, path } = qrDrawing(text);
  return (
    <svg
      className={codeStyles.code}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}

/** Saves one code as an SVG file named after the quest. */
function download(code: Code, language: Language): void {
  const blob = new Blob([qrSvgFile(code.url)], { type: "image/svg+xml" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${textFor(code.title, language) || code.questId}.svg`;
  link.click();
  // Later, not in the same tick: Safari would cancel the download.
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

/** A category in every language the event wrote it in, like the titles. */
const bothLanguages = (text: Code["category"]): string =>
  [text.ar, text.en].filter((part) => part !== null).join(" · ");

/** Codes the API names (an ended event, a quest gone) keep their own words; anything else gets the page's. */
const GENERIC = new Set([undefined, "internal_error"]);

function RegenerateDialog({
  language,
  busy,
  cancel,
  confirm,
}: Readonly<{ language: Language; busy: boolean; cancel: () => void; confirm: () => void }>) {
  const t = translatorFor(language);
  const heading = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div role="alertdialog" aria-labelledby="regenerate-title" className={styles.card}>
      <h2 id="regenerate-title" ref={heading} tabIndex={-1} className={styles.subtitle}>
        {t("codes.regenerateTitle")}
      </h2>
      <p>{t("codes.regenerateBody")}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className={styles.button} disabled={busy} onClick={confirm}>
          {t("codes.regenerate")}
        </button>
      </div>
    </div>
  );
}

/**
 * An event's printed quest codes (FR-305, FR-1711; UX §3.5): one card per quest with a code, in the event's languages,
 * printed or saved as PDF by the browser. "New code" makes the printed one stop working at once, after a confirmation.
 */
export function CodesPanel({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [codes, setCodes] = useState<readonly Code[] | null>(null);
  const [large, setLarge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<Code | null>(null);
  const loaded = useRef(false);

  const [loadFailed, setLoadFailed] = useState(false);

  /** False after a refusal, which it shows: the page's own words for a failure the API does not name (UX §3.5). */
  const handle = (
    body: unknown,
    ok: boolean,
    fallback: "codes.loadFailed" | "codes.regenerateFailed",
  ) => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return false;
    }
    if (!ok) {
      setProblem(GENERIC.has(code) ? t(fallback) : describeProblem(body, language, t).text);
    }
    return ok;
  };

  const load = async () => {
    setProblem(null);
    setLoadFailed(false);
    const result = await requestJson("GET", `${base}/codes`);
    if (handle(result.body, result.ok, "codes.loadFailed")) {
      setCodes((result.body as { codes: Code[] }).codes);
    } else {
      setLoadFailed(true);
    }
  };

  useEffect(() => {
    // Once per page, also under Strict Mode's double effect.
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load();
    // `load` only reads state setters and the page's language.
  }, [base]);

  useEffect(() => {
    // "Print QR" links here with #code-{id}; the cards arrive after the first paint, so the browser cannot scroll to it.
    const target = codes === null ? null : document.getElementById(window.location.hash.slice(1));
    if (target !== null && window.location.hash.startsWith("#code-")) {
      target.scrollIntoView({ block: "center" });
      target.focus();
    }
  }, [codes]);

  const regenerate = async () => {
    if (regenerating === null) {
      return;
    }
    const target = regenerating;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson("POST", `${base}/quests/${target.questId}/qr/regenerate`);
    setBusy(false);
    setRegenerating(null);
    if (handle(result.body, result.ok, "codes.regenerateFailed")) {
      const fresh = result.body as { version: number; url: string };
      setCodes((current) =>
        (current ?? []).map((code) =>
          code.questId === target.questId ? { ...code, ...fresh } : code,
        ),
      );
      setNotice(t("codes.regenerated"));
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="codes-title">
      <div className={codeStyles.controls}>
        <a
          className={styles.textLink}
          href={`/${language}/organizers/${organizerId}/events/${eventId}/quests`}
        >
          {t("codes.toBuilder")}
        </a>
        <h1 id="codes-title" className={styles.title}>
          {t("codes.title")}
        </h1>
        {problem === null ? null : (
          <p role="alert" className={styles.alert}>
            {problem}
          </p>
        )}
        {loadFailed ? (
          <button type="button" className={styles.button} onClick={() => void load()}>
            {t("common.retry")}
          </button>
        ) : null}
        {notice === null ? null : (
          <p role="status" className={styles.notice}>
            {notice}
          </p>
        )}
        {regenerating === null ? null : (
          <RegenerateDialog
            language={language}
            busy={busy}
            cancel={() => setRegenerating(null)}
            confirm={() => void regenerate()}
          />
        )}
        {codes !== null && codes.length > 0 ? (
          <div className={styles.actions}>
            <fieldset className={styles.choices}>
              <legend>{t("codes.size")}</legend>
              {([false, true] as const).map((option) => (
                <label key={String(option)} className={styles.check}>
                  <input
                    type="radio"
                    name="size"
                    checked={large === option}
                    onChange={() => setLarge(option)}
                  />
                  <span>{t(option ? "codes.sizeLarge" : "codes.sizeSmall")}</span>
                </label>
              ))}
            </fieldset>
            <button type="button" className={styles.button} onClick={() => window.print()}>
              {t("codes.print")}
            </button>
          </div>
        ) : null}
      </div>
      {codes === null ? (
        problem === null ? (
          <p className={styles.muted}>{t("common.loading")}</p>
        ) : null
      ) : codes.length === 0 ? (
        <p className={styles.muted}>{t("codes.empty")}</p>
      ) : (
        <ul className={`${codeStyles.sheet} ${large ? codeStyles.large : ""}`}>
          {codes.map((code) => (
            <li
              key={code.questId}
              id={`code-${code.questId}`}
              tabIndex={-1}
              className={codeStyles.card}
            >
              <QrImage
                text={code.url}
                label={t("codes.codeFor", { name: textFor(code.title, language) })}
              />
              {code.title.ar === null ? null : (
                <p className={codeStyles.title} dir="rtl" lang="ar">
                  {code.title.ar}
                </p>
              )}
              {code.title.en === null ? null : (
                <p className={codeStyles.title} dir="ltr" lang="en">
                  {code.title.en}
                </p>
              )}
              <p className={codeStyles.small}>{bothLanguages(code.category)}</p>
              <p className={codeStyles.small}>{t("codes.version", { version: code.version })}</p>
              <div className={`${styles.actions} ${codeStyles.controls}`}>
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={() => download(code, language)}
                >
                  {t("codes.download")}
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={busy}
                  onClick={() => setRegenerating(code)}
                >
                  {t("codes.regenerate")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
