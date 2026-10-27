"use client";
import type { AdminInvitationDetail, InvitationApproveBody, Language } from "@questify/shared";
import { useEffect, useState } from "react";
import {
  approvalRefusalText,
  invitationPath,
  isRenamed,
  readApproved,
  readDetail,
} from "#src/lib/console-invitations.ts";
import { eventRefusalText, riyadhTime } from "#src/lib/invitations.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { useInvitationWrites } from "#src/lib/use-invitation-writes.ts";

/** What went wrong in this page's words: a rename since the page was read, the event's and the approval's refusals. */
function problemText(body: unknown, language: Language, t: Translate): string {
  if (isRenamed(body)) {
    return t("console.invCampaign.renamed");
  }
  return (
    eventRefusalText(body, t) ??
    approvalRefusalText(body, t) ??
    describeProblem(body, language, t).text
  );
}

export type DetailState = AdminInvitationDetail | "loading" | "missing";

/**
 * One request in the console: read on arrival and after every write (a 409 means the page is out of date, a rename
 * included, so it is read again and the admin approves the new text). One write at a time.
 */
export function useConsoleInvitation(language: Language, campaignId: string) {
  const t = translatorFor(language);
  const path = invitationPath(campaignId);
  const [detail, setDetail] = useState<DetailState>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const writes = useInvitationWrites(language, (body) => problemText(body, language, t));

  const load = async (): Promise<void> => {
    const result = await requestJson("GET", path);
    const read = result.ok ? readDetail(result.body) : undefined;
    // A read that fails after the page was shown keeps what was shown; the next write or visit reads again.
    setDetail((shown) => read ?? (typeof shown === "string" ? "missing" : shown));
  };

  useEffect(() => {
    void load();
    // Once per request: the page is keyed by its id.
  }, [campaignId]);

  /** Approves with the names the page showed; true when approved. */
  const approve = async (body: InvitationApproveBody): Promise<boolean> => {
    setNotice(null);
    const result = await writes.write("POST", `${path}/approve`, body);
    if (result.ok) {
      const approved = readApproved(result.body);
      const moved = approved?.sendAtMoved === true && approved.campaign.sendAt !== null;
      setNotice(
        moved
          ? t("console.invCampaign.sendAtMoved", {
              time: riyadhTime(approved.campaign.sendAt ?? "", language),
            })
          : t("console.invCampaign.approved"),
      );
    }
    if (result.ok || result.status === 409) {
      await load();
    }
    return result.ok;
  };

  const close = async (action: "refuse" | "cancel", note: string): Promise<void> => {
    setNotice(null);
    const result = await writes.write("POST", `${path}/${action}`, { note });
    if (result.ok) {
      setNotice(
        t(action === "refuse" ? "console.invCampaign.refused" : "console.invCampaign.cancelled"),
      );
    }
    if (result.ok || result.status === 409) {
      await load();
    }
  };

  return { detail, notice, busy: writes.busy, problem: writes.problem, approve, close };
}
