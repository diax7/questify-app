import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helpDocSchema } from "@questify/shared";
import type { RequestContext } from "#src/db/context";
import { pushFixture, type PushFixture } from "#test/support/push";
import { addMember } from "#test/support/test-db";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Doc = Record<string, unknown>;

/** A call's SQLSTATE and detail ("LG400:text.ar"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const doc = (extra: Doc = {}): Doc => ({
  question: { ar: "كيف أنضم؟", en: "How do I join?" },
  answer: { ar: "امسح الرمز.", en: "Scan the code." },
  position: 1,
  published: true,
  ...extra,
});

const TEXT_AR = "نص الوثيقة";
const TEXT_EN = "The text of the document";

/**
 * Legal versions and the help articles in the database (T-707, migration 0123): the six documents start at 0.1, an
 * admin publishes later versions that are in force at once and can never be changed, an organizer's owner (and only the
 * owner) accepts the organizer documents, and the help articles are edited, audited and reverted like the catalogs.
 * Every table is closed to the API's role; every admin door is for an active platform admin only (QE403).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("legal versions and help (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  let adminId = "";
  let ownerB = "";

  beforeAll(async () => {
    f = await pushFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('legal@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
    ownerB = await addMember(f.db.owner, f.ids.orgB, "owner");
  });
  afterAll(async () => {
    await f.close();
  });

  const one = async <T>(sql: string, values: unknown[] = [], seat: RequestContext = admin) =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const publish = (document: string, version: string, ar = TEXT_AR, en = TEXT_EN, seat = admin) =>
    one<Doc>(
      "SELECT admin_legal_publish($1, $2, $3, $4, 'a note', $5) AS r",
      [document, version, ar, en, randomUUID()],
      seat,
    );
  const inForce = async () =>
    Object.fromEntries(
      (
        await one<{ document: string; version: string }[]>("SELECT legal_in_force() AS r", [], {})
      ).map((item) => [item.document, item.version]),
    );
  const audits = (action: string, target?: string) =>
    f.owner<{ actor_id: string; target_id: string; before: Doc | null; after: Doc }>(
      `SELECT actor_id, target_id, before, after FROM audit_log
       WHERE action = $1 AND ($2::text IS NULL OR target_id = $2) ORDER BY id`,
      [action, target ?? null],
    );

  const pending = (organizer: string, staff: string) =>
    one<{ document: string; version: string }[]>(
      "SELECT organizer_legal_missing($1) AS r",
      [organizer],
      f.team(staff, organizer),
    );
  const accept = (organizer: string, staff: string, documents: unknown) =>
    f.run(f.team(staff, organizer), "SELECT accept_organizer_documents($1, $2)", [
      organizer,
      JSON.stringify(documents),
    ]);
  const save = (id: string, body: unknown, revertOf: string | null = null, seat = admin) =>
    one<Doc>(
      "SELECT admin_help_article_save($1, $2, $3, $4) AS r",
      [id, body, revertOf, randomUUID()],
      seat,
    );
  const list = () => one<Doc[]>("SELECT admin_help_articles() AS r");
  const shown = () => one<{ id: string }[]>("SELECT help_articles() AS r", [], {});
  const latestEntry = async (id: string) =>
    (
      await f.owner<{ id: string }>(
        `SELECT id FROM audit_log WHERE target_type = 'help_article' AND target_id = $1
         ORDER BY id DESC LIMIT 1`,
        [id],
      )
    )[0]?.id ?? "";

  describe("who may ask", () => {
    it("closes both tables to the API's role, and every admin door to all but an active admin", async () => {
      for (const table of ["legal_version", "help_article"]) {
        expect(await refusal(f.run({}, `SELECT * FROM ${table}`))).toBe("42501");
        expect(await refusal(f.run({}, `DELETE FROM ${table}`))).toBe("42501");
      }
      const [off] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('legal-off@questify.test', 'h', 'admin', 'disabled') RETURNING id",
      );
      const seats: RequestContext[] = [
        f.team(),
        f.team(ownerB, f.ids.orgB),
        { playerId: await f.newPlayer() },
        { isAdmin: true },
        { isAdmin: true, staffUserId: ownerB },
        { isAdmin: true, staffUserId: off?.id ?? "" },
        { staffUserId: adminId },
        {},
      ];
      const request = randomUUID();
      const calls = [
        "SELECT admin_legal_list()",
        `SELECT admin_legal_publish('terms_of_use', '9', 'a', 'b', NULL, '${request}')`,
        "SELECT admin_help_articles()",
        `SELECT admin_help_article_save('faq', '{}', NULL, '${request}')`,
      ];
      for (const seat of seats) {
        for (const call of calls) {
          expect(await refusal(f.run(seat, call)), `${call} ${JSON.stringify(seat)}`).toBe("QE403");
        }
      }
      expect(await inForce()).toMatchObject({ terms_of_use: "0.1" });
    });

    it("lets PUBLIC execute nothing it should not (only the public reads and the doors go to the API role)", async () => {
      const rows = await f.owner<{ name: string; public_can: boolean; api_can: boolean }>(
        `SELECT p.proname AS name, has_function_privilege('public', p.oid, 'EXECUTE') AS public_can,
                has_function_privilege('questify_app', p.oid, 'EXECUTE') AS api_can
         FROM pg_proc p WHERE p.proname IN ('legal_in_force', 'legal_text', 'admin_legal_list',
           'admin_legal_publish', 'organizer_legal_missing', 'accept_organizer_documents', 'help_articles',
           'admin_help_articles', 'admin_help_article_save', 'legal_version_key', 'legal_in_force_rows',
           'help_text', 'admin_help_doc', 'legal_version_append_only', 'player_legal_held')`,
      );
      expect(rows.length).toBe(15);
      expect(rows.filter((row) => row.public_can)).toEqual([]);
      // The helpers are internal: only the definers that call them can.
      const internal = [
        "legal_version_key",
        "legal_in_force_rows",
        "help_text",
        "admin_help_doc",
        "legal_version_append_only",
      ];
      expect(
        rows
          .filter((row) => row.api_can)
          .map((row) => row.name)
          .toSorted(),
      ).toEqual(
        rows
          .map((row) => row.name)
          .filter((name) => !internal.includes(name))
          .toSorted(),
      );
    });
  });

  describe("the versions", () => {
    it("starts with the six documents at 0.1, readable signed out, and names an unknown document as nothing", async () => {
      expect(await inForce()).toEqual({
        terms_of_use: "0.1",
        privacy_policy: "0.1",
        community_guidelines: "0.1",
        organizer_terms: "0.1",
        organizer_dpa: "0.1",
        organizer_content_rules: "0.1",
      });
      const text = await one<Doc>("SELECT legal_text('privacy_policy') AS r", [], {});
      expect(text).toMatchObject({
        document: "privacy_policy",
        version: "0.1",
        ar: null,
        en: null,
      });
      expect(await one("SELECT legal_text('passwords') AS r", [], {})).toBeNull();
    });

    it("puts a published version in force at once, with its text, its note and an audit entry", async () => {
      const made = await publish("privacy_policy", "1");
      expect(made).toMatchObject({ document: "privacy_policy", version: "1" });
      expect((await inForce())["privacy_policy"]).toBe("1");
      expect(await one("SELECT legal_text('privacy_policy') AS r", [], {})).toMatchObject({
        version: "1",
        ar: TEXT_AR,
        en: TEXT_EN,
      });
      const [entry] = await audits("legal.publish", "privacy_policy");
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before).toEqual({ version: "0.1" });
      expect(entry?.after).toEqual({ version: "1", note: "a note" });
      const documents = await one<{ document: string; versions: Doc[] }[]>(
        "SELECT admin_legal_list() AS r",
      );
      const privacy = documents.find((item) => item.document === "privacy_policy");
      expect(
        privacy?.versions.map((item) => [item["version"], item["inForce"], item["hasText"]]),
      ).toEqual([
        ["1", true, true],
        ["0.1", false, false],
      ]);
    });

    it("compares versions as numbers and refuses one that is not later (LG409)", async () => {
      await publish("terms_of_use", "0.9");
      await publish("terms_of_use", "0.10");
      expect((await inForce())["terms_of_use"]).toBe("0.10");
      for (const version of ["0.10", "0.9", "0.1", "0.10.0"]) {
        expect(await refusal(publish("terms_of_use", version)), version).toBe("LG409:0.10");
      }
      await publish("terms_of_use", "0.10.1");
      expect((await inForce())["terms_of_use"]).toBe("0.10.1");
    });

    it("refuses an unknown document, a malformed version, blank or oversize texts and a long note (LG400)", async () => {
      expect(await refusal(publish("passwords", "1"))).toBe("LG400:document");
      for (const version of [
        "",
        "v1",
        "1.2.3.4",
        "1,5",
        "-1",
        "1.",
        "99999",
        "1.99999999999",
        "99999999999999999999",
      ]) {
        expect(await refusal(publish("community_guidelines", version)), version).toBe(
          "LG400:version",
        );
      }
      expect(await refusal(publish("community_guidelines", "2", "   ", TEXT_EN))).toBe(
        "LG400:text.ar",
      );
      expect(await refusal(publish("community_guidelines", "2", TEXT_AR, ""))).toBe(
        "LG400:text.en",
      );
      expect(await refusal(publish("community_guidelines", "2", "ا".repeat(100_001)))).toBe(
        "LG400:text.ar",
      );
      expect(
        await refusal(
          f.run(
            admin,
            "SELECT admin_legal_publish('community_guidelines', '2', 'a', 'b', $1, $2)",
            ["n".repeat(301), randomUUID()],
          ),
        ),
      ).toBe("LG400:note");
      expect((await inForce())["community_guidelines"]).toBe("0.1");
    });

    it("lets two publishes of the same version race and keeps exactly one", async () => {
      const results = await Promise.all([
        refusal(publish("organizer_dpa", "5")),
        refusal(publish("organizer_dpa", "5")),
      ]);
      expect(results.toSorted()).toEqual(["LG409:5", "none"]);
    });

    it("can never change or remove a published version, even as the table's owner", async () => {
      expect(await refusal(f.owner("UPDATE legal_version SET body_en = 'x'"))).toBe("42501");
      expect(await refusal(f.owner("DELETE FROM legal_version"))).toBe("42501");
      expect(await refusal(f.owner("TRUNCATE legal_version"))).toBe("42501");
    });
  });

  describe("organizers accept the documents", () => {
    it("lists what an organizer has not accepted, only to its own members", async () => {
      await f.owner(
        `INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by)
         SELECT $1, d, '0.1', $2 FROM unnest(ARRAY['organizer_terms','organizer_dpa','organizer_content_rules']) d
         ON CONFLICT DO NOTHING`,
        [f.ids.orgA, f.ownerA],
      );
      await publish("organizer_terms", "2");
      expect(await pending(f.ids.orgA, f.ownerA)).toEqual([
        { document: "organizer_dpa", version: "5" },
        { document: "organizer_terms", version: "2" },
      ]);
      // An organizer with no acceptance on record has no earlier version to re-accept (it is always made with all three).
      expect(await pending(f.ids.orgB, ownerB)).toEqual([]);
      // A member of another organizer, a player and a stranger learn nothing about this one.
      expect(
        await one(
          "SELECT organizer_legal_missing($1) AS r",
          [f.ids.orgA],
          f.team(ownerB, f.ids.orgB),
        ),
      ).toEqual([]);
      expect(
        await one("SELECT organizer_legal_missing($1) AS r", [f.ids.orgA], {
          playerId: await f.newPlayer(),
        }),
      ).toEqual([]);
      expect(await one("SELECT organizer_legal_missing($1) AS r", [f.ids.orgA], {})).toEqual([]);
    });

    it("records the owner's acceptance of the versions in force, once, with an audit entry", async () => {
      const documents = [
        { document: "organizer_terms", version: "2" },
        { document: "organizer_dpa", version: "5" },
      ];
      await accept(f.ids.orgA, f.ownerA, documents);
      await accept(f.ids.orgA, f.ownerA, documents);
      expect(await pending(f.ids.orgA, f.ownerA)).toEqual([]);
      const rows = await f.owner<{ document: string; version: string; accepted_by: string }>(
        `SELECT document, version, accepted_by FROM organizer_acceptance
         WHERE organizer_id = $1 AND version <> '0.1' ORDER BY document`,
        [f.ids.orgA],
      );
      expect(rows).toEqual([
        { document: "organizer_dpa", version: "5", accepted_by: f.ownerA },
        { document: "organizer_terms", version: "2", accepted_by: f.ownerA },
      ]);
      expect((await audits("organizer.legal.accept"))[0]?.actor_id).toBe(f.ownerA);
    });

    it("refuses an editor, another organizer's owner, a stale version and a player document", async () => {
      await publish("organizer_content_rules", "3");
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const fresh = [{ document: "organizer_content_rules", version: "3" }];
      expect(await refusal(accept(f.ids.orgA, editor, fresh))).toBe("QE403");
      expect(
        await refusal(
          f.run(f.team(ownerB, f.ids.orgB), "SELECT accept_organizer_documents($1, $2)", [
            f.ids.orgA,
            JSON.stringify(fresh),
          ]),
        ),
      ).toBe("QE403");
      expect(
        await refusal(
          f.run({}, "SELECT accept_organizer_documents($1, $2)", [
            f.ids.orgA,
            JSON.stringify(fresh),
          ]),
        ),
      ).toBe("QE403");
      for (const documents of [
        [{ document: "organizer_content_rules", version: "2" }],
        [{ document: "terms_of_use", version: "0.10.1" }],
        [{ document: "organizer_content_rules", version: "99" }],
        [],
        {},
      ]) {
        expect(
          await refusal(accept(f.ids.orgA, f.ownerA, documents)),
          JSON.stringify(documents),
        ).toBe("LG412");
      }
      expect(await pending(f.ids.orgA, f.ownerA)).toEqual([
        { document: "organizer_content_rules", version: "3" },
      ]);
      await accept(f.ids.orgA, f.ownerA, fresh);
      expect(await pending(f.ids.orgA, f.ownerA)).toEqual([]);
    });
  });

  describe("help articles", () => {
    it("makes an article, shows it to the public only while published, in order", async () => {
      await save("join", doc());
      await save(
        "prizes",
        doc({
          position: 3,
          question: { ar: "", en: "Prizes?" },
          answer: { ar: "", en: "At the desk." },
        }),
      );
      await save("draft", doc({ position: 2, published: false }));
      await save("early", doc({ position: 1 }));
      expect((await shown()).map((item) => item.id)).toEqual(["early", "join", "prizes"]);
      expect((await list()).map((item) => item["id"])).toEqual([
        "early",
        "join",
        "draft",
        "prizes",
      ]);
      const [entry] = await audits("catalog.help.update", "join");
      expect(entry?.before).toBeNull();
      expect(helpDocSchema.safeParse(entry?.after).success).toBe(true);
    });

    it("keeps an article in one language: the other language is empty, not invented", async () => {
      const prizes = (await shown()).find((item) => item.id === "prizes") as Doc;
      expect(prizes["question"]).toEqual({ ar: "", en: "Prizes?" });
      expect(prizes["answer"]).toEqual({ ar: "", en: "At the desk." });
    });

    it("refuses a half-filled language, no language, control characters and bad ids (CA400)", async () => {
      expect(await refusal(save("bad", doc({ answer: { ar: "", en: "x" } })))).toBe(
        "CA400:languages",
      );
      expect(
        await refusal(
          save("bad", doc({ question: { ar: "", en: "" }, answer: { ar: "", en: "" } })),
        ),
      ).toBe("CA400:languages");
      expect(
        await refusal(
          save("bad", doc({ question: { ar: "س", en: "Q" + String.fromCharCode(1) } })),
        ),
      ).toBe("CA400:question.en");
      expect(
        await refusal(
          save("bad", doc({ answer: { ar: "ج", en: "A" + String.fromCharCode(0x202e) } })),
        ),
      ).toBe("CA400:answer.en");
      expect(await refusal(save("bad", doc({ question: { ar: "س".repeat(201), en: "Q" } })))).toBe(
        "CA400:question.ar",
      );
      expect(await refusal(save("bad", doc({ position: 0 })))).toBe("CA400:position");
      for (const id of ["Bad", "1abc", "has space", "a".repeat(65)]) {
        expect(await refusal(save(id, doc())), id).toBe("CA400:id");
      }
      expect((await list()).some((item) => item["id"] === "bad")).toBe(false);
    });

    it("writes nothing when nothing changed, then audits an edit and reverts it", async () => {
      const before = (await audits("catalog.help.update", "join")).length;
      await save("join", doc());
      expect((await audits("catalog.help.update", "join")).length).toBe(before);
      await save("join", doc({ answer: { ar: "امسح الرمز الآن.", en: "Scan the code now." } }));
      const [, edit] = await audits("catalog.help.update", "join");
      expect(edit?.actor_id).toBe(adminId);
      expect((edit?.before?.["answer"] as Doc | undefined)?.["en"]).toBe("Scan the code.");
      const reverted = await save("join", null, await latestEntry("join"));
      expect(reverted["answer"]).toEqual({ ar: "امسح الرمز.", en: "Scan the code." });
      expect((await audits("catalog.help.revert", "join")).length).toBe(1);
    });

    it("refuses a revert of an unknown article (CA404) and one another change has passed (CA409)", async () => {
      expect(await refusal(save("nothing", null, "1"))).toBe("CA404");
      await save("early", doc({ position: 1, answer: { ar: "ب", en: "B" } }));
      const stale = await latestEntry("early");
      await save("early", doc({ position: 1, answer: { ar: "ج", en: "C" } }));
      expect(await refusal(save("early", null, stale))).toBe("CA409");
    });
  });
});
