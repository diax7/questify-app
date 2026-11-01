import type { Contact, CustomPage, FaqEntry } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { contactRows, contactTarget, faqRows, partViews } from "#src/event/info-page.ts";

const words = (en: string, ar = "") => ({ ar, en });
const contact = (kind: Contact["kind"], value: string, label = words("Desk")): Contact => ({
  label,
  kind,
  value,
});

const entry = (question: string, answer: string): FaqEntry => ({
  question: words(question),
  answer: words(answer),
});
const page = (blocks: CustomPage["blocks"]): CustomPage => ({ title: words("Rules"), blocks });

describe("contactTarget", () => {
  it("opens the mail app for an email address and the phone app for a number", () => {
    expect(contactTarget(contact("email", "desk@example.com"))).toEqual({
      kind: "mailto",
      url: "mailto:desk@example.com",
    });
    expect(contactTarget(contact("phone", "+966501234567"))).toEqual({
      kind: "tel",
      url: "tel:+966501234567",
    });
  });

  it("asks before a website opens, naming its host", () => {
    expect(contactTarget(contact("link", "https://Example.com/event?x=1"))).toEqual({
      kind: "link",
      url: "https://Example.com/event?x=1",
      host: "example.com",
    });
  });
});

describe("contactRows", () => {
  it("names each contact in the player's language, else the other one", () => {
    const rows = contactRows(
      [
        contact("phone", "0501234567", words("Front desk", "الاستقبال")),
        contact("email", "a@b.co", words("Press")),
      ],
      "ar",
    );
    expect(rows.map((row) => row.label)).toEqual(["الاستقبال", "Press"]);
    expect(rows[0]?.target.kind).toBe("tel");
  });

  it("leaves out a contact with no name in either language", () => {
    expect(contactRows([contact("phone", "0501234567", words(""))], "en")).toEqual([]);
  });
});

describe("faqRows", () => {
  it("keeps the organizer's order and drops an entry missing its question or its answer", () => {
    const rows = faqRows(
      [entry("First?", "Yes"), entry("", "Orphan"), entry("Third?", ""), entry("Last?", "No")],
      "en",
    );
    expect(rows).toEqual([
      { question: "First?", answer: "Yes" },
      { question: "Last?", answer: "No" },
    ]);
  });

  it("falls back to the other language for a text that was written in one", () => {
    expect(faqRows([entry("Where?", "Hall 2")], "ar")).toEqual([
      { question: "Where?", answer: "Hall 2" },
    ]);
  });
});

describe("partViews", () => {
  it("turns every kind of part into what the screen draws", () => {
    const views = partViews(
      page([
        { kind: "heading", text: words("Before you come") },
        { kind: "text", text: words("No bags inside.") },
        { kind: "list", items: words("ID card\n\nTicket\n") },
        { kind: "link", label: words("Map"), url: "https://example.com/map" },
      ]),
      "en",
    );
    expect(views).toEqual([
      { kind: "heading", text: "Before you come" },
      { kind: "text", text: "No bags inside." },
      { kind: "list", items: ["ID card", "Ticket"] },
      { kind: "link", label: "Map", url: "https://example.com/map", host: "example.com" },
    ]);
  });

  it("leaves out a part with nothing to say", () => {
    expect(
      partViews(
        page([
          { kind: "text", text: words("") },
          { kind: "list", items: words("\n \n") },
          { kind: "link", label: words(""), url: "https://example.com" },
          { kind: "heading", text: words("Kept") },
        ]),
        "en",
      ),
    ).toEqual([{ kind: "heading", text: "Kept" }]);
  });

  it("reads a page with no part as nothing to open", () => {
    expect(partViews(page([]), "en")).toEqual([]);
  });
});
