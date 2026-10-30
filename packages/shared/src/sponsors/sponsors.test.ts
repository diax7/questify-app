import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  SPONSOR_TAG_KINDS,
  SPONSOR_TIERS,
  memberSponsorsSchema,
  sponsorBodySchema,
  sponsorTagBodySchema,
  teamSponsorListSchema,
  tierKey,
} from "#src/sponsors/sponsors";

const issueOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.success ? null : result.error?.issues[0]?.path[0];

describe("sponsor checks", () => {
  it("wants a name in one language at least, a tier, and no other field", () => {
    expect(sponsorBodySchema.safeParse({ nameEn: "Acme", tier: "gold" }).success).toBe(true);
    expect(
      sponsorBodySchema.safeParse({ nameAr: "شركة", nameEn: null, tier: "partner", booth: "B14" })
        .success,
    ).toBe(true);
    expect(issueOf(sponsorBodySchema.safeParse({ tier: "gold" }))).toBe("name");
    expect(issueOf(sponsorBodySchema.safeParse({ nameEn: "  ", nameAr: "", tier: "gold" }))).toBe(
      "name",
    );
    expect(sponsorBodySchema.safeParse({ nameEn: "Acme" }).success).toBe(false);
    expect(sponsorBodySchema.safeParse({ nameEn: "Acme", tier: "diamond" }).success).toBe(false);
    expect(sponsorBodySchema.safeParse({ nameEn: "x".repeat(61), tier: "gold" }).success).toBe(
      false,
    );
    expect(
      sponsorBodySchema.safeParse({ nameEn: "Acme", tier: "gold", booth: "b".repeat(41) }).success,
    ).toBe(false);
  });

  it("accepts no contact, link or player field (FR-1304)", () => {
    for (const extra of [
      { email: "a@b.sa" },
      { phone: "+966500000000" },
      { url: "https://a.sa" },
    ]) {
      expect(sponsorBodySchema.safeParse({ nameEn: "Acme", tier: "gold", ...extra }).success).toBe(
        false,
      );
    }
  });

  it("tags a quest, a category or a reward, or clears a tag, and nothing else", () => {
    const id = crypto.randomUUID();
    for (const kind of SPONSOR_TAG_KINDS) {
      expect(sponsorTagBodySchema.safeParse({ kind, targetId: id, sponsorId: id }).success).toBe(
        true,
      );
    }
    expect(
      sponsorTagBodySchema.safeParse({ kind: "quest", targetId: id, sponsorId: null }).success,
    ).toBe(true);
    expect(
      sponsorTagBodySchema.safeParse({ kind: "souvenir", targetId: id, sponsorId: id }).success,
    ).toBe(false);
    expect(
      sponsorTagBodySchema.safeParse({ kind: "quest", targetId: "x", sponsorId: id }).success,
    ).toBe(false);
  });

  it("has words for every tier in both languages", () => {
    for (const tier of SPONSOR_TIERS) {
      const words = MESSAGES[tierKey(tier)];
      expect(words.ar).not.toBe("");
      expect(words.en).not.toBe("");
    }
  });

  it("reads the lists the doors answer", () => {
    const id = crypto.randomUUID();
    expect(
      teamSponsorListSchema.safeParse({
        sponsors: [{ id, nameAr: null, nameEn: "Acme", tier: "gold", booth: null, tags: [] }],
      }).success,
    ).toBe(true);
    expect(
      memberSponsorsSchema.safeParse({
        sponsors: [{ id, name: { ar: "Acme", en: "Acme" }, tier: "gold", booth: "B1" }],
        tags: [{ kind: "quest", targetId: id, sponsorId: id }],
      }).success,
    ).toBe(true);
    expect(
      memberSponsorsSchema.safeParse({ sponsors: [], tags: [{ kind: "quest" }] }).success,
    ).toBe(false);
  });
});
