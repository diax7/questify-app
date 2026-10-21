import { describe, expect, it } from "vitest";
import {
  missingAcceptances,
  missingSignupAcceptances,
  organizerDocuments,
  playerDocuments,
} from "#src/legal/documents";

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

describe("player documents", () => {
  it("lists the terms, the privacy policy and the guidelines with their versions", () => {
    expect(playerDocuments()).toEqual([
      { id: "terms_of_use", field: "terms", version: "0.1" },
      { id: "privacy_policy", field: "privacy", version: "0.1" },
      { id: "community_guidelines", field: "guidelines", version: "0.1" },
    ]);
  });

  it("asks only for the terms and privacy at sign-up, and only the ones not in force", () => {
    expect(missingSignupAcceptances({ terms: "0.1", privacy: "0.1" })).toEqual([]);
    expect(missingSignupAcceptances({ terms: "0.1" })).toEqual(["privacy_policy"]);
    expect(missingSignupAcceptances({ terms: "0.0", privacy: "0.2" })).toEqual([
      "terms_of_use",
      "privacy_policy",
    ]);
    expect(missingSignupAcceptances({})).toEqual(["terms_of_use", "privacy_policy"]);
  });
});
