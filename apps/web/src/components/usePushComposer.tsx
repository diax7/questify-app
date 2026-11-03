"use client";

import { formatNumber, type GroupPushPreview, type Language } from "@questify/shared";
import { useState } from "react";
import { keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import {
  BLANK_PUSH,
  GROUP_PUSH_API,
  GROUP_PUSH_PREVIEW_API,
  checkPush,
  readPreview,
  savedPushText,
  type PushDraft,
} from "#src/lib/console-group-push.ts";
import { TEMPLATES_API, readTemplates } from "#src/lib/console-messaging.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";

/**
 * The state of the group push form (T-706b): the draft, the rules' verdict on it, the review of who would receive it and
 * the confirmed send. Any change to the form clears the review and the last answer, so a send is always the one that
 * was reviewed; a sent push clears the form and reads the list again.
 */
export function usePushComposer(language: Language, reloadHistory: () => Promise<void>) {
  const t = translatorFor(language);
  const templates = useConsoleRead(TEMPLATES_API, readTemplates);
  const [draft, setDraft] = useState<PushDraft>(BLANK_PUSH);
  const [preview, setPreview] = useState<GroupPushPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const { ask, dialog } = useConfirmation(language);
  const write = useWrite(language, (done) => {
    setNotice(done);
    setPreview(null);
    setDraft(BLANK_PUSH);
    void reloadHistory();
  });
  const checked = checkPush(draft);

  const change = (patch: Partial<PushDraft>) => {
    setDraft({ ...draft, ...patch });
    setPreview(null);
    setNotice(null);
    setProblem(null);
  };
  const review = async () => {
    if (!checked.ok) return;
    setLooking(true);
    const result = await requestJson("POST", GROUP_PUSH_PREVIEW_API, checked.body);
    setLooking(false);
    const reviewed = result.ok ? readPreview(result.body) : undefined;
    setPreview(reviewed ?? null);
    setProblem(reviewed === undefined ? describeProblem(result.body, language, t).text : null);
  };
  const askToSend = () => {
    if (!checked.ok || preview === null) return;
    const { body } = checked;
    ask({
      title: t("console.push.confirm.title"),
      body: t("console.push.confirm.body", { count: formatNumber(preview.reach, language) }),
      confirmLabel: t("console.push.send"),
      run: () =>
        write.run(() => requestJson("POST", GROUP_PUSH_API, body, keyed()), t("console.push.sent")),
    });
  };

  return {
    draft,
    checked,
    preview,
    notice,
    problem: problem ?? write.problem,
    busy: looking || write.busy,
    saved: templates.state.kind === "ready" ? savedPushText(templates.state.value) : undefined,
    dialog,
    change,
    review,
    askToSend,
  };
}
