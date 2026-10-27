import { JOIN_LINK_HOSTS, type Language, trimName } from "@questify/shared";

/**
 * The invitation SMS (ADR-331 (3)): a fixed template, no organizer text, no brand prefix (the "-AD" sender name says it
 * is Questify), gender-neutral, at most 3 SMS parts. The event's name is the campaign's copy made at approval, never the
 * event's live name (Finding 1 (a)), cut by `trimName`. The link carries the recipient's token in the fragment, which
 * never reaches a server log or a `Referer` (ADR-332 (2)).
 */

/** The names an admin approved, copied onto the campaign. */
export type ApprovedNames = Readonly<{ ar: string | null; en: string | null }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
/** The preview's stand-ins: the real lengths of a link token (16 bytes) and an opt-out token (33 bytes) in base64url. */
const PLACEHOLDER_LINK = "X".repeat(22);
const PLACEHOLDER_OPT_OUT = "X".repeat(44);

/** The 22-character token of a recipient's link id. */
export function invitationToken(link: string): string {
  if (!UUID.test(link)) throw new Error("An invitation token needs the recipient's link UUID.");
  return Buffer.from(link.replaceAll("-", ""), "hex").toString("base64url");
}

/** The link id a token stands for, or null when it is not one (the public route answers 400 then). */
export function readInvitationToken(token: string): string | null {
  if (!TOKEN.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== token) return null;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The landing page a message links to, in the message's language, the token in the fragment. */
export function invitationUrl(language: Language, token: string): string {
  return `https://${JOIN_LINK_HOSTS[0]}/${language}/i#${token}`;
}

/** The approved name in the message's language, else the other one; the approval guarantees one of them. */
function nameFor(names: ApprovedNames, language: Language): string {
  const own = names[language]?.trim() ?? "";
  const other = names[language === "ar" ? "en" : "ar"]?.trim() ?? "";
  const chosen = own === "" ? other : own;
  if (chosen === "")
    throw new Error("An invitation needs an approved event name in either language.");
  return trimName(chosen);
}

export type InvitationText = Readonly<{
  language: Language;
  names: ApprovedNames;
  /** The landing page's URL (`invitationUrl`). */
  link: string;
  /** The signed opt-out link for this player and channel (`optOutUrl`). */
  optOut: string;
}>;

/** The SMS text, exactly as sent. */
export function renderInvitation(input: InvitationText): string {
  const name = nameFor(input.names, input.language);
  return input.language === "ar"
    ? `دعوة إلى ${name}: ${input.link}\nإيقاف العروض: ${input.optOut}`
    : `Invitation to ${name}: ${input.link}\nStop offers: ${input.optOut}`;
}

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "\f^{}\\[~]|€";

/** The SMS septets of a text in the GSM 7-bit alphabet, or null when it needs UCS-2. */
function gsmSeptets(text: string): number | null {
  let septets = 0;
  for (const char of text) {
    if (GSM_BASIC.includes(char)) septets += 1;
    else if (GSM_EXTENDED.includes(char)) septets += 2;
    else return null;
  }
  return septets;
}

/** How many SMS parts a text takes: GSM-7 160 alone or 153 a part, else UCS-2 70 alone or 67 a part (UTF-16 units). */
export function smsParts(text: string): number {
  const septets = gsmSeptets(text);
  if (septets !== null) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}

/**
 * The console's preview of the message for the names it shows: the same template with placeholder tokens of the real
 * length, never a real token. Null when neither name can be sent.
 */
export function previewInvitation(
  names: ApprovedNames,
  language: Language,
): Readonly<{ text: string; parts: number }> | null {
  if ((names.ar?.trim() ?? "") === "" && (names.en?.trim() ?? "") === "") return null;
  const text = renderInvitation({
    language,
    names,
    link: invitationUrl(language, PLACEHOLDER_LINK),
    optOut: `https://${JOIN_LINK_HOSTS[0]}/${language}/opt-out?t=${PLACEHOLDER_OPT_OUT}`,
  });
  return { text, parts: smsParts(text) };
}
