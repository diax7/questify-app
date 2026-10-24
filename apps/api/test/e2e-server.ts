import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { Pool } from "pg";
import { buildApp } from "#src/app";
import type { EmailMessage, EmailSender } from "#src/auth/email/sender";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { createStaff, testConfig } from "#test/support/auth-app";
import { createTestDatabase, seedTwoTenants } from "#test/support/test-db";

/**
 * The real API for the web app's browser tests (apps/web/e2e), on a throw-away database. Test code only: it is
 * bundled and started by Playwright, never part of the product. Sign-in codes are written to a file the tests read,
 * so the product needs no test endpoint.
 *
 * Settings: TEST_DATABASE_URL, E2E_API_PORT, E2E_WEB_ORIGIN (the browser's origin), E2E_CODES_FILE, E2E_CONTROL_PORT.
 */
const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set for the e2e API server.`);
  }
  return value;
};

/** The password the e2e breach list knows (e2e/paths.ts has the same text). */
const E2E_BREACHED_PASSWORD = "this one was in a breach 2019";

/** Keeps the last sign-in code and the last reset or invite link sent to each address in a JSON file. */
class FileEmailSender implements EmailSender {
  readonly name = "e2e-file";
  private readonly mail: { codes: Record<string, string>; links: Record<string, string> } = {
    codes: {},
    links: {},
  };

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.mail));
  }

  send(message: EmailMessage): Promise<void> {
    const link = /https?:\/\/\S+\/(?:reset-password|invite)#token=[A-Za-z0-9_-]+/.exec(
      message.text,
    )?.[0];
    const code = /(?<![0-9])[0-9]{6}(?![0-9])/.exec(message.text)?.[0];
    if (link !== undefined) {
      this.mail.links[message.to] = link;
    } else if (code !== undefined) {
      this.mail.codes[message.to] = code;
    }
    writeFileSync(this.file, JSON.stringify(this.mail));
    return Promise.resolve();
  }
}

async function main(): Promise<void> {
  const port = Number(required("E2E_API_PORT"));
  const db = await createTestDatabase();
  const ids = await seedTwoTenants(db.owner);
  // One editor account per test and browser size (an organizer has one owner), so the per-account limits (5 codes an hour) never cross tests.
  for (const size of ["desktop", "phone"]) {
    for (const name of ["ar", "en", "keys", "resend", "reset", "change", "creator"]) {
      const id = await createStaff(db.owner, { email: `${name}.${size}@najd.test` });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [ids.orgA, id],
      );
    }
    await createStaff(db.owner, { email: `new.${size}@najd.test` });
  }
  const pool = new Pool({ connectionString: db.appUrl, max: 8 });
  const config = {
    ...testConfig(db.appUrl, { dashboardOrigin: required("E2E_WEB_ORIGIN") }),
    port,
  };
  const app = buildApp({
    config,
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: new FileEmailSender(required("E2E_CODES_FILE")),
    breachCheck: (password) => Promise.resolve(password === E2E_BREACHED_PASSWORD),
    logger: false,
  });
  const stop = async (): Promise<void> => {
    await app.close();
    await pool.end();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await app.listen({ host: "127.0.0.1", port });
  startControl(Number(required("E2E_CONTROL_PORT")), db);
}

/**
 * Two players with an open location case each (T-303b): `usernames[0]` scanned once 2.4 km from the venue with a fake
 * location reported (far from the venue); `usernames[1]` scanned two placed quests 910 m apart, edge to edge, 40
 * seconds apart (impossible speed). The cases are written directly, as the completion trigger would.
 */
async function seedLocationFlags(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  eventId: string,
  usernames: readonly string[],
): Promise<void> {
  const [far, fast] = usernames;
  if (far === undefined || fast === undefined) {
    throw new Error("usernames must hold two names");
  }
  const run = async (sql: string, values: unknown[]) => (await db.owner.query(sql, values)).rows;
  const enroll = async (username: string) => {
    const [row] = await run(
      `WITH made AS (INSERT INTO player (username) VALUES ($2) RETURNING id)
       INSERT INTO enrollment (organizer_id, event_id, player_id)
       SELECT e.organizer_id, e.id, made.id FROM event e, made WHERE e.id = $1
       RETURNING id, organizer_id`,
      [eventId, username],
    );
    return row as { id: string; organizer_id: string };
  };
  const spot = async (en: string, ar: string, lat: number) => {
    const [row] = await run(
      `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, place_lat, place_lng, place_radius_m)
       SELECT $1, c.id, 'scan_qr', $2, $3, 10, $4, 46.6753, 100
       FROM (SELECT id FROM category WHERE event_id = $1 LIMIT 1) c
       RETURNING id`,
      [eventId, en, ar, lat],
    );
    return (row as { id: string }).id;
  };
  const complete = async (
    who: { id: string; organizer_id: string },
    quest: string,
    ago: number,
  ) => {
    const [row] = await run(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, 1, 'qr', gen_random_uuid()::text, now() - make_interval(secs => $5))
       RETURNING id`,
      [who.organizer_id, eventId, who.id, quest, ago],
    );
    return (row as { id: string }).id;
  };
  const raise = (who: { id: string; organizer_id: string }, kind: string, completions: string[]) =>
    run(
      `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
       VALUES ($1, $2, $3, $4, jsonb_build_object('completions', $5::jsonb)) ON CONFLICT DO NOTHING`,
      [who.organizer_id, eventId, who.id, kind, JSON.stringify(completions.map(Number))],
    );
  const gateA = await spot("Gate A", "البوابة أ", 24.7136);
  const hallC = await spot("Hall C", "القاعة ج", 24.7236);
  const farPlayer = await enroll(far);
  const farScan = await complete(farPlayer, gateA, 0);
  await run(
    `INSERT INTO completion_position (completion_id, organizer_id, event_id, enrollment_id, accuracy_m, mocked,
                                      venue_distance_m)
     VALUES ($1, $2, $3, $4, 30, true, 2400)`,
    [farScan, farPlayer.organizer_id, eventId, farPlayer.id],
  );
  await raise(farPlayer, "far_from_venue", [farScan]);
  const fastPlayer = await enroll(fast);
  const first = await complete(fastPlayer, gateA, 40);
  const second = await complete(fastPlayer, hallC, 0);
  await raise(fastPlayer, "impossible_speed", [first, second]);
}

/**
 * Test-only control on its own local port: `POST /event-status {eventId, status}` moves an event the way Questify's
 * activation will (T-210), so a browser test can work on a live event. Never part of the API.
 */
function startControl(port: number, db: Awaited<ReturnType<typeof createTestDatabase>>): void {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      let body: {
        eventId?: string;
        status?: string;
        usernames?: string[];
        points?: number[];
        flagged?: string[];
        email?: string;
        texts?: string[];
      };
      try {
        body = JSON.parse(raw || "{}") as typeof body;
      } catch (error) {
        response.writeHead(400).end(String(error));
        return;
      }
      // /flagged: enrolls new players and gives each ten scans of new quests at once, which opens a burst case (T-209).
      if (request.url === "/flagged") {
        db.owner
          .query(
            `WITH made AS (INSERT INTO player (username) SELECT unnest($2::text[]) RETURNING id),
                  joined AS (INSERT INTO enrollment (organizer_id, event_id, player_id)
                             SELECT e.organizer_id, e.id, made.id FROM event e, made WHERE e.id = $1
                             RETURNING id, organizer_id, event_id),
                  quests AS (INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points)
                             SELECT $1, c.id, 'scan_qr', 'Lion ' || n, 'الأسد ' || n, 10
                             FROM (SELECT id FROM category WHERE event_id = $1 LIMIT 1) c, generate_series(1, 10) n
                             RETURNING id)
             INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                           idempotency_key)
             SELECT j.organizer_id, j.event_id, j.id, q.id, 1, 'qr', gen_random_uuid()::text FROM joined j, quests q`,
            [body.eventId, body.usernames ?? []],
          )
          .then((result) => {
            response
              .writeHead(result.rowCount === (body.usernames ?? []).length * 10 ? 204 : 404)
              .end();
          })
          .catch((error: unknown) => {
            response.writeHead(400).end(String(error));
          });
        return;
      }
      // /location-flagged: two new players, [0] far from the venue (one scan, 2.4 km away, a fake location) and [1]
      // too fast between two placed quests (910 m in 40 s), each with an open case (T-303b).
      if (request.url === "/location-flagged") {
        seedLocationFlags(db, body.eventId ?? "", body.usernames ?? [])
          .then(() => {
            response.writeHead(204).end();
          })
          .catch((error: unknown) => {
            response.writeHead(400).end(String(error));
          });
        return;
      }
      // /scored: enrolls new players with these usernames, each holding its points (in order) as a staff award, and
      // opens a burst case on the `flagged` ones (the results page, T-214).
      if (request.url === "/scored") {
        db.owner
          .query(
            `WITH made AS (INSERT INTO player (username)
                           SELECT unnest($2::text[]) RETURNING id, username),
                  joined AS (INSERT INTO enrollment (organizer_id, event_id, player_id)
                             SELECT e.organizer_id, e.id, made.id FROM event e, made WHERE e.id = $1
                             RETURNING id, organizer_id, event_id, player_id),
                  scored AS (
                    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta,
                                              balance_delta, actor, staff_user_id)
                    SELECT j.organizer_id, j.event_id, j.id, 'award', p.points, p.points, 'staff',
                           (SELECT m.staff_user_id FROM organizer_member m WHERE m.organizer_id = j.organizer_id LIMIT 1)
                    FROM joined j JOIN made m ON m.id = j.player_id
                    JOIN unnest($2::text[], $3::int[]) AS p(username, points) ON p.username = m.username
                    RETURNING enrollment_id)
             INSERT INTO flag (organizer_id, event_id, enrollment_id, kind)
             SELECT j.organizer_id, j.event_id, j.id, 'burst' FROM joined j JOIN made m ON m.id = j.player_id
             WHERE m.username = ANY ($4::text[]) AND EXISTS (SELECT 1 FROM scored)`,
            [body.eventId, body.usernames ?? [], body.points ?? [], body.flagged ?? []],
          )
          .then(() => {
            response.writeHead(204).end();
          })
          .catch((error: unknown) => {
            response.writeHead(400).end(String(error));
          });
        return;
      }
      // /submitted: a text submission quest worth 150, and one pending submission per username with its text, in order
      // (the dashboard's submissions page, T-301).
      if (request.url === "/submitted") {
        db.owner
          .query(
            `WITH made AS (INSERT INTO player (username)
                           SELECT unnest($2::text[]) RETURNING id, username),
                  joined AS (INSERT INTO enrollment (organizer_id, event_id, player_id)
                             SELECT e.organizer_id, e.id, made.id FROM event e, made WHERE e.id = $1
                             RETURNING id, organizer_id, event_id, player_id),
                  quest AS (INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, type_config)
                            SELECT $1, c.id, 'submission', 'Tell us', 'أخبرنا', 150,
                                   '{"accepts": ["text"], "autoApprove": false, "resubmit": false}'
                            FROM (SELECT id FROM category WHERE event_id = $1 LIMIT 1) c
                            RETURNING id)
             INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status,
                                     idempotency_key)
             SELECT j.organizer_id, j.event_id, j.id, q.id, 'text', p.body, 150, 'pending', gen_random_uuid()::text
             FROM joined j JOIN made m ON m.id = j.player_id
             JOIN unnest($2::text[], $3::text[]) AS p(username, body) ON p.username = m.username, quest q`,
            [body.eventId, body.usernames ?? [], body.texts ?? []],
          )
          .then((result) => {
            response.writeHead(result.rowCount === (body.usernames ?? []).length ? 204 : 404).end();
          })
          .catch((error: unknown) => {
            response.writeHead(400).end(String(error));
          });
        return;
      }
      // /account: makes a player account with this username and email (the deletion page, T-217).
      if (request.url === "/account") {
        db.owner
          .query(
            `WITH made AS (INSERT INTO player (username) VALUES ($1) RETURNING id)
             INSERT INTO player_contact (player_id, email) SELECT id, $2 FROM made`,
            [body.usernames?.[0] ?? null, body.email ?? null],
          )
          .then(() => {
            response.writeHead(204).end();
          })
          .catch((error: unknown) => {
            response.writeHead(400).end(String(error));
          });
        return;
      }
      // /player-token: enrolls a new player with this username and answers a bearer token of theirs, so a browser test
      // can scan a station's code as that player through the API (T-309).
      if (request.url === "/player-token") {
        const token = randomBytes(32).toString("base64url");
        db.owner
          .query(
            `WITH made AS (INSERT INTO player (username) VALUES ($2) RETURNING id),
                  joined AS (INSERT INTO enrollment (organizer_id, event_id, player_id)
                             SELECT e.organizer_id, e.id, made.id FROM event e, made WHERE e.id = $1)
             INSERT INTO player_session (player_id, token_hash, expires_at)
             SELECT id, $3, now() + interval '1 hour' FROM made`,
            [
              body.eventId,
              body.usernames?.[0] ?? null,
              createHash("sha256").update(token).digest(),
            ],
          )
          .then(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ token }));
          })
          .catch((error: unknown) => {
            response.writeHead(400).end(String(error));
          });
        return;
      }
      // /players: enrolls new players with these usernames in the event (the dashboard's players page, T-208), active
      // unless `status` says otherwise (`pending`: join requests, T-218).
      if (request.url === "/players") {
        db.owner
          .query(
            `WITH made AS (INSERT INTO player (username) SELECT unnest($2::text[]) RETURNING id)
             INSERT INTO enrollment (organizer_id, event_id, player_id, status)
             SELECT e.organizer_id, e.id, made.id, coalesce($3, 'active') FROM event e, made WHERE e.id = $1`,
            [body.eventId, body.usernames ?? [], body.status ?? null],
          )
          .then((result) => {
            response.writeHead(result.rowCount === (body.usernames ?? []).length ? 204 : 404).end();
          })
          .catch((error: unknown) => {
            response.writeHead(400).end(String(error));
          });
        return;
      }
      const times =
        body.status === "live"
          ? ["-1 hour", "1 day"]
          : body.status === "ended"
            ? ["-2 days", "-1 day"]
            : ["1 day", "2 days"];
      db.owner
        .query(
          "UPDATE event SET status = $2, starts_at = now() + $3::interval, ends_at = now() + $4::interval WHERE id = $1",
          [body.eventId, body.status, times[0], times[1]],
        )
        .then((result) => {
          response.writeHead(result.rowCount === 1 ? 204 : 404).end();
        })
        .catch((error: unknown) => {
          response.writeHead(400).end(String(error));
        });
    });
  });
  server.listen(port, "127.0.0.1");
}

void main().catch((error: unknown) => {
  process.stderr.write(`e2e API server failed: ${String(error)}\n`);
  process.exit(1);
});
