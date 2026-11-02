import { describe, expect, it } from "vitest";
import {
  isLegalDocumentId,
  missingAcceptances,
  missingSignupAcceptances,
  organizerDocuments,
  playerDocuments,
  signupDocuments,
  type LegalInForce,
} from "#src/legal/documents";

const IN_FORCE: LegalInForce = [
  { document: "terms_of_use", version: "2" },
  { document: "privacy_policy", version: "1.1" },
  { document: "community_guidelines", version: "0.1" },
  { document: "organizer_terms", version: "0.1" },
  { document: "organizer_dpa", version: "3" },
  { document: "organizer_content_rules", version: "0.1" },
];

describe("organizerDocuments", () => {
  it("lists the three documents an organizer accepts with the versions in force", () => {
    expect(organizerDocuments(IN_FORCE)).toEqual([
      { id: "organizer_terms", field: "terms", version: "0.1" },
      { id: "organizer_dpa", field: "dpa", version: "3" },
      { id: "organizer_content_rules", field: "contentRules", version: "0.1" },
    ]);
  });

  it("leaves out a document that has no version in force", () => {
    expect(organizerDocuments([])).toEqual([]);
  });
});

describe("missingAcceptances", () => {
  const current = { terms: "0.1", dpa: "3", contentRules: "0.1" };

  it("is empty when every current version is accepted", () => {
    expect(missingAcceptances(IN_FORCE, current)).toEqual([]);
  });

  it("names each document accepted at another version or not at all", () => {
    expect(missingAcceptances(IN_FORCE, { ...current, dpa: "2" })).toEqual(["organizer_dpa"]);
    expect(missingAcceptances(IN_FORCE, {})).toEqual([
      "organizer_terms",
      "organizer_dpa",
      "organizer_content_rules",
    ]);
  });
});

describe("player documents", () => {
  it("lists the terms, the privacy policy and the guidelines with their versions", () => {
    expect(playerDocuments(IN_FORCE)).toEqual([
      { id: "terms_of_use", field: "terms", version: "2" },
      { id: "privacy_policy", field: "privacy", version: "1.1" },
      { id: "community_guidelines", field: "guidelines", version: "0.1" },
    ]);
    expect(signupDocuments(IN_FORCE).map((document) => document.id)).toEqual([
      "terms_of_use",
      "privacy_policy",
    ]);
  });

  it("asks only for the terms and privacy at sign-up, and only the ones not in force", () => {
    expect(missingSignupAcceptances(IN_FORCE, { terms: "2", privacy: "1.1" })).toEqual([]);
    expect(missingSignupAcceptances(IN_FORCE, { terms: "2" })).toEqual(["privacy_policy"]);
    expect(missingSignupAcceptances(IN_FORCE, { terms: "1", privacy: "1.2" })).toEqual([
      "terms_of_use",
      "privacy_policy",
    ]);
    expect(missingSignupAcceptances(IN_FORCE, {})).toEqual(["terms_of_use", "privacy_policy"]);
  });
});

describe("isLegalDocumentId", () => {
  it("knows the six documents and nothing else", () => {
    expect(isLegalDocumentId("organizer_dpa")).toBe(true);
    expect(isLegalDocumentId("../etc/passwd")).toBe(false);
    expect(isLegalDocumentId(undefined)).toBe(false);
  });
});
