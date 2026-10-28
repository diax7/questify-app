import {
  checkAnnouncement,
  toInstant,
  type AnnouncementBody,
  type MessageKey,
} from "@questify/shared";

export const blankAnnouncement = (): AnnouncementBody => ({
  titleAr: "",
  titleEn: "",
  bodyAr: "",
  bodyEn: "",
});

const ISSUE_KEYS: Readonly<Record<string, MessageKey>> = {
  required: "announcements.page.issue.required",
  too_long: "announcements.page.issue.tooLong",
  looks_like_address: "announcements.page.issue.looksLikeAddress",
  looks_like_phone: "announcements.page.issue.looksLikePhone",
  control_characters: "announcements.page.issue.controlCharacters",
  "sendAt:past": "announcements.page.issue.sendAt.past",
  "sendAt:too_far": "announcements.page.issue.sendAt.tooFar",
  "sendAt:before_start": "announcements.page.issue.sendAt.beforeStart",
  "sendAt:after_end": "announcements.page.issue.sendAt.afterEnd",
};

export const announcementIssueKey = (issue: string): MessageKey =>
  ISSUE_KEYS[issue] ?? "announcements.page.issue.required";

export function announcementPayload(
  draft: AnnouncementBody,
  later: boolean,
  local: string,
  zone: string,
): AnnouncementBody | null {
  const checked = checkAnnouncement(draft);
  if (!checked.ok) return null;
  try {
    const sendAt = later ? toInstant(local, zone) : null;
    return {
      titleAr: checked.draft.titleAr,
      titleEn: checked.draft.titleEn,
      bodyAr: checked.draft.bodyAr,
      bodyEn: checked.draft.bodyEn,
      sendAt: sendAt?.toISOString() ?? null,
    };
  } catch {
    return null;
  }
}
