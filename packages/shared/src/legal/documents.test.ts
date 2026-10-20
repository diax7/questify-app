import { describe, expect, it } from "vitest";
import { missingAcceptances, organizerDocuments } from "#src/legal/documents";

describe("organizerDocuments", () => {
  it("lists the three documents an organizer accepts, each with a version", () => {
    expect(organizerDocuments().map((document) => document.id)).toEqual([
      "organizer_terms",
      "organizer_dpa",
      "organizer_content_rules",
    ]);
    for (const document of organizerDocuments()) {
      expect(document.version).toMatch(/^[0-9]+(\.[0-9]+){0,2}$/);
    }
  });
});

describe("missingAcceptances", () => {
  const current = Object.fromEntries(
    organizerDocuments().map((document) => [document.field, document.version]),
  );

  it("is empty when every current version is accepted", () => {
    expect(missingAcceptances(current)).toEqual([]);
  });

  it("names each document accepted at another version or not at all", () => {
    expect(missingAcceptances({ ...current, dpa: "0.0" })).toEqual(["organizer_dpa"]);
    expect(missingAcceptances({})).toEqual([
      "organizer_terms",
      "organizer_dpa",
      "organizer_content_rules",
    ]);
  });
});
