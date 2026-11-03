import { createHash, randomBytes, randomUUID } from "node:crypto";
import { QR_QUEST_TYPES } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { sqlstate } from "#test/support/push";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

const sha = (value: string | Buffer): Buffer => createHash("sha256").update(value).digest();
const REVIEWER = "+966500000711";

type Code = { kind: string; id: string; version: number; quest_id: string | null };

/**
 * The App Review demo's QR picker in the database (T-710b, migration 0147, ADR-565, ADR-640): the reviewer, in the demo
 * event, while the window is open, reads every printable code and gets a fictional player's meet code; another event, a
 * real player, a fictional one and a closed window are refused with RD404. Window close runs last.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("review demo QR picker (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};
  let reviewer = "";
  let event = "";
  let organizer = "";
  const made: Record<string, string> = {};

  const quest = async (category: string, type: string, extra: Record<string, unknown> = {}) => {
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, verification, visible)
       VALUES ($1, $2, $3, $4, 10, 5, $5, $6, $7) RETURNING id`,
      [
        event,
        category,
        type,
        `${type} quest`,
        JSON.stringify(extra["config"] ?? {}),
        extra["verification"] ?? ["quest_qr"],
        extra["visible"] ?? true,
      ],
    );
    return row?.id ?? "";
  };

  beforeAll(async () => {
    f = await questifyFixture();
    const [staff] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('rdc@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: staff?.id ?? "" };
    await f.run(admin, "SELECT console_review_demo_create($1, $2, $3, $4, $5)", [
      REVIEWER,
      sha(`key:${REVIEWER}`),
      sha(`fp:${REVIEWER}`),
      ["agenda"],
      randomUUID(),
    ]);
    await f.run(admin, "SELECT console_review_demo_prepare($1, $2, $3, $4, 14, '1.5.0', $5)", [
      REVIEWER,
      sha(`key:${REVIEWER}`),
      sha(`fp:${REVIEWER}`),
      sha("reviewer:424242"),
      randomUUID(),
    ]);
    const [demo] = await f.owner<{ player_id: string; event_id: string; organizer_id: string }>(
      "SELECT player_id, event_id, organizer_id FROM review_demo",
    );
    reviewer = demo?.player_id ?? "";
    event = demo?.event_id ?? "";
    organizer = demo?.organizer_id ?? "";
    const [ev] = await f.owner<{ join_code: string }>("SELECT join_code FROM event WHERE id = $1", [
      event,
    ]);
    await f.asPlayer(reviewer, "SELECT * FROM join_event($1, 'code', '0.1')", [ev?.join_code]);

    const [open] = await f.owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en, position) VALUES ($1, 'Booths', 1) RETURNING id",
      [event],
    );
    const [secret] = await f.owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en, hidden, position) VALUES ($1, 'Secret', true, 2) RETURNING id",
      [event],
    );
    made["secret"] = secret?.id ?? "";
    made["qr"] = await quest(open?.id ?? "", "scan_qr");
    made["hiddenQuest"] = await quest(open?.id ?? "", "scan_qr", { visible: false });
    made["deleted"] = await quest(open?.id ?? "", "scan_qr");
    await f.owner(
      "UPDATE quest SET deleted_at = now(), deleted_by = $2, visible = false WHERE id = $1",
      [made["deleted"], staff?.id],
    );
    made["meet"] = await quest(open?.id ?? "", "meet", {
      config: { dailyCap: 5 },
      verification: [],
    });
    made["tagged"] = await quest(open?.id ?? "", "scan_qr", { verification: ["quest_qr", "nfc"] });
    const [trail] = await f.owner<{ id: string; quest_id: string }>(
      `WITH q AS (
         INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, verification)
         VALUES ($1, $2, 'passport', 'Booth trail', 30, '{"needed": 1}', '{}') RETURNING id)
       INSERT INTO passport_step (event_id, quest_id, name_en) SELECT $1, id, 'Booth 1' FROM q
       RETURNING id, quest_id`,
      [event, open?.id],
    );
    made["passport"] = trail?.quest_id ?? "";
    made["step"] = trail?.id ?? "";
    const tags = await f.owner<{ id: string }>(
      `INSERT INTO nfc_tag (id, organizer_id, event_id, quest_id, uid, label, locked, status, revoked_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '\\x04a1b2c3', 'Gate', true, 'active', NULL),
              (gen_random_uuid(), $1, $2, $3, '\\x04a1b2c4', 'Old', true, 'revoked', now())
       RETURNING id`,
      [organizer, event, made["tagged"]],
    );
    made["tag"] = tags[0]?.id ?? "";
    made["revokedTag"] = tags[1]?.id ?? "";
  });
  afterAll(async () => {
    await f.close();
  });

  const codes = (player: string, ev = event) =>
    f.asPlayer<Code>(player, "SELECT kind, id, version, quest_id FROM review_demo_codes($1, $2)", [
      ev,
      QR_QUEST_TYPES,
    ]);
  const here = async (player: string, ev = event) =>
    (await f.asPlayer<{ here: boolean }>(player, "SELECT review_demo_here($1) AS here", [ev]))[0]
      ?.here;
  const meetCode = (player: string, target: string, token = randomBytes(16), ev = event) =>
    f.asPlayer<{ pass_id: string }>(player, "SELECT * FROM review_demo_meet_code($1, $2, $3)", [
      ev,
      target,
      sha(token),
    ]);
  const fictional = async () =>
    (
      await f.owner<{ player_id: string }>(
        "SELECT player_id FROM review_demo_player WHERE role = 'fictional' ORDER BY player_id LIMIT 1",
      )
    )[0]?.player_id ?? "";

  it("lists every printable code of the demo event to the reviewer, and nothing deleted, hidden or revoked", async () => {
    expect(await here(reviewer)).toBe(true);
    const listed = await codes(reviewer);
    const pairs = listed.map((code) => `${code.kind}:${code.id}`).toSorted();
    expect(pairs).toEqual(
      [
        `quest:${made["qr"]}`,
        `quest:${made["tagged"]}`,
        `step:${made["step"]}`,
        `reveal:${made["secret"]}`,
        `tag:${made["tag"]}`,
        `meet:${made["meet"]}`,
      ].toSorted(),
    );
    expect(listed.find((code) => code.kind === "step")?.quest_id).toBe(made["passport"]);
    expect(listed.every((code) => code.version >= 1)).toBe(true);
  });

  it("refuses another event, a real player, a fictional player and an unknown event (RD404)", async () => {
    const real = await f.newPlayer();
    const realEvent = await f.newEvent({ phase: "live" });
    await f.join(realEvent, real);
    const stand = await fictional();
    for (const [player, ev] of [
      [reviewer, realEvent],
      [reviewer, randomUUID()],
      [real, realEvent],
      [real, event],
      [stand, event],
    ] as const) {
      expect(await here(player, ev)).toBe(false);
      expect(await sqlstate(codes(player, ev))).toBe("RD404");
      expect(await sqlstate(meetCode(player, made["meet"] ?? "", randomBytes(16), ev))).toBe(
        "RD404",
      );
    }
    expect(await sqlstate(f.run({}, "SELECT * FROM review_demo_codes($1, '{}')", [event]))).toBe(
      "RD404",
    );
  });

  it("refuses a reviewer who left the event", async () => {
    await f.owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1 AND event_id = $2", [
      reviewer,
      event,
    ]);
    try {
      expect(await sqlstate(codes(reviewer))).toBe("RD404");
    } finally {
      await f.owner(
        "UPDATE enrollment SET status = 'active' WHERE player_id = $1 AND event_id = $2",
        [reviewer, event],
      );
    }
  });

  it("issues a fictional player's meet code the reviewer's scan pays, then the next player's", async () => {
    const token = randomBytes(16);
    const [pass] = await meetCode(reviewer, made["meet"] ?? "", token);
    expect(pass?.pass_id).toBeDefined();
    const [shown] = await f.owner<{ role: string }>(
      `SELECT r.role FROM meet_pass p JOIN enrollment n ON n.id = p.enrollment_id
       JOIN review_demo_player r ON r.player_id = n.player_id WHERE p.id = $1`,
      [pass?.pass_id],
    );
    expect(shown?.role).toBe("fictional");
    const [met] = await f.asPlayer<{ points: string }>(
      reviewer,
      "SELECT points FROM meet_player($1, $2, NULL, NULL)",
      [sha(token), randomUUID()],
    );
    expect(Number(met?.points)).toBe(10);
    const [next] = await meetCode(reviewer, made["meet"] ?? "");
    const enrollments = await f.owner<{ enrollment_id: string }>(
      "SELECT enrollment_id FROM meet_pass WHERE id IN ($1, $2)",
      [pass?.pass_id, next?.pass_id],
    );
    expect(new Set(enrollments.map((row) => row.enrollment_id)).size).toBe(2);
  });

  it("refuses a quest that is not a meet quest, or of another event, and answers none_left with no one to meet", async () => {
    expect(await sqlstate(meetCode(reviewer, made["qr"] ?? ""))).toBe("QT422");
    const other = await f.newEvent({ phase: "live" });
    const [elsewhere] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       SELECT $1, id, 'meet', 'Meet', 5, '{"dailyCap": 5}' FROM category WHERE event_id = $1 RETURNING id`,
      [other],
    );
    expect(await sqlstate(meetCode(reviewer, elsewhere?.id ?? ""))).toBe("RD404");
    const fictionals = `UPDATE enrollment SET status = $2 WHERE event_id = $1
      AND player_id IN (SELECT player_id FROM review_demo_player WHERE role = 'fictional')`;
    await f.owner(fictionals, [event, "left"]);
    try {
      expect(await sqlstate(meetCode(reviewer, made["meet"] ?? ""))).toBe("RD409");
    } finally {
      await f.owner(fictionals, [event, "active"]);
    }
  });

  it("from the outsider's seat, grants the three doors to the API's role alone", async () => {
    const held = await f.owner<{ proname: string; grantee: string }>(
      `SELECT DISTINCT p.proname, CASE WHEN a.grantee = 0 THEN 'public' ELSE a.grantee::regrole::text END AS grantee
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.proname IN ('review_demo_here', 'review_demo_codes', 'review_demo_meet_code')
         AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1`,
    );
    expect(held).toEqual(
      ["review_demo_codes", "review_demo_here", "review_demo_meet_code"].map((proname) => ({
        proname,
        grantee: "questify_app",
      })),
    );
  });

  it("refuses everything once the window closes", async () => {
    await f.run(admin, "SELECT console_review_demo_close($1)", [randomUUID()]);
    expect(await here(reviewer)).toBe(false);
    expect(await sqlstate(codes(reviewer))).toBe("RD404");
    expect(await sqlstate(meetCode(reviewer, made["meet"] ?? ""))).toBe("RD404");
  });
});
