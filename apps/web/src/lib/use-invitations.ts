"use client";
import type { InvitationCampaigns, InvitationRequestBody, Language } from "@questify/shared";
import { useEffect, useState } from "react";
import {
  invitationProblemText,
  invitationsPath,
  readCampaign,
  readCampaigns,
} from "#src/lib/invitations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { useInvitationWrites } from "#src/lib/use-invitation-writes.ts";

export type InvitationsProps = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
}>;

/** One event's invitation requests: read on arrival and after each write; the owner's request and withdrawal. */
export function useInvitations({ language, organizerId, eventId }: InvitationsProps) {
  const t = translatorFor(language);
  const api = invitationsPath(organizerId, eventId);
  const [list, setList] = useState<InvitationCampaigns | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const writes = useInvitationWrites(language, (body) => invitationProblemText(body, language, t));
  const { fail } = writes;

  const load = async (): Promise<void> => {
    const result = await requestJson("GET", api);
    const read = result.ok ? readCampaigns(result.body) : undefined;
    if (read !== undefined) {
      setList(read);
    } else if (result.ok) {
      writes.setProblem(t("invCampaign.loadFailed"));
    } else {
      fail(result.body);
    }
  };

  useEffect(() => {
    void load();
    // Once per page: the page is keyed by its event.
  }, []);

  /** Asks for invitations; true when the request was made. A conflict means the list is out of date, so it is read. */
  const submit = async (body: InvitationRequestBody): Promise<boolean> => {
    setNotice(null);
    const result = await writes.write("POST", api, body);
    if (result.ok && readCampaign(result.body) !== undefined) {
      setNotice(t("invCampaign.requested"));
    }
    if (result.ok || result.status === 409) {
      await load();
    }
    return result.ok;
  };

  const withdraw = async (campaignId: string): Promise<void> => {
    setNotice(null);
    const result = await writes.write("DELETE", `${api}/${campaignId}`);
    if (result.ok || result.status === 409) {
      await load();
    }
  };

  /** The form was edited: what the last attempt said no longer applies. */
  const dismiss = (): void => {
    writes.setProblem(null);
    setNotice(null);
  };

  return { list, busy: writes.busy, problem: writes.problem, notice, submit, withdraw, dismiss };
}
export type InvitationsModel = ReturnType<typeof useInvitations>;
