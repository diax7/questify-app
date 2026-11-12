import {
  linkHost,
  listItems,
  type Contact,
  type CustomPage,
  type FaqEntry,
  type Language,
} from "@questify/shared";
import { localIn } from "#src/event/home-content.ts";

/** Where a tap on a contact leads (T-613): the phone's mail or phone app, or a web page after the player agrees. */
export type ContactTarget =
  | Readonly<{ kind: "mailto" | "tel"; url: string }>
  | Readonly<{ kind: "link"; url: string; host: string }>;

/**
 * The tap for one contact. An email address and a phone number were checked by the server to hold nothing but the address or the
 * digits (no `?`, `&`, `%` or space), so the link made of them can carry nothing else.
 */
export function contactTarget(contact: Contact): ContactTarget {
  switch (contact.kind) {
    case "email":
      return { kind: "mailto", url: `mailto:${contact.value}` };
    case "phone":
      return { kind: "tel", url: `tel:${contact.value}` };
    default:
      return { kind: "link", url: contact.value, host: linkHost(contact.value) };
  }
}

export type ContactRow = Readonly<{ label: string; value: string; target: ContactTarget }>;

/** The contacts as rows in the player's language; one with no name in either language is left out. */
export function contactRows(contacts: readonly Contact[], language: Language): ContactRow[] {
  return contacts.flatMap((contact) => {
    const label = localIn(contact.label, language);
    return label === "" ? [] : [{ label, value: contact.value, target: contactTarget(contact) }];
  });
}

export type FaqRow = Readonly<{ question: string; answer: string }>;

/** The questions with their answers in the player's language; an entry missing either one is left out. */
export function faqRows(faq: readonly FaqEntry[], language: Language): FaqRow[] {
  return faq.flatMap((entry) => {
    const question = localIn(entry.question, language);
    const answer = localIn(entry.answer, language);
    return question === "" || answer === "" ? [] : [{ question, answer }];
  });
}

/** One part of the custom page as the screen draws it. */
export type PartView =
  | Readonly<{ kind: "heading" | "text"; text: string }>
  | Readonly<{ kind: "list"; items: string[] }>
  | Readonly<{ kind: "link"; label: string; url: string; host: string }>
  /** An organizer picture (T-613b), with its words for a screen reader. */
  | Readonly<{ kind: "image"; image: string; alt: string }>;

/** The page's parts in order, in the player's language; a part with nothing to say is left out. */
export function partViews(page: CustomPage, language: Language): PartView[] {
  return page.blocks.flatMap((block): PartView[] => {
    if (block.kind === "link") {
      const label = localIn(block.label, language);
      return label === ""
        ? []
        : [{ kind: "link", label, url: block.url, host: linkHost(block.url) }];
    }
    if (block.kind === "list") {
      const items = listItems(localIn(block.items, language));
      return items.length === 0 ? [] : [{ kind: "list", items }];
    }
    if (block.kind === "image") {
      return [{ kind: "image", image: block.image, alt: localIn(block.alt, language) }];
    }
    const text = localIn(block.text, language);
    return text === "" ? [] : [{ kind: block.kind, text }];
  });
}
