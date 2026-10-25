import { writeFile } from "node:fs/promises";
import { souvenirFixture } from "#test/support/souvenirs";
import { paySouvenirs } from "#src/souvenirs/payer";

/** Manual synthetic20k-recipient evidence, never touches a real event/database. Not a timing-sensitive CI gate. */
async function measure() {
  const f = await souvenirFixture();
  try {
    await f.db.owner.query(
      "INSERT INTO player(username) SELECT 'souvenir_load_'||i FROM generate_series(1,20000) i",
    );
    await f.db.owner.query(
      "INSERT INTO enrollment(organizer_id,event_id,player_id) SELECT $1,$2,p.id FROM player p WHERE username LIKE 'souvenir_load_%'",
      [f.ids.orgA, f.ids.eventA],
    );
    const rule = await f.create();
    await f.action(rule);
    const sourceStarted = Date.now();
    await f.db.owner.query("UPDATE enrollment SET waitlisted=waitlisted WHERE event_id=$1", [
      f.ids.eventA,
    ]);
    const sourceMs = Date.now() - sourceStarted;
    const started = Date.now();
    const batches: { elapsedMs: number; granted: number; skipped: number; failed: number }[] = [];
    let due = 20001;
    while (due > 0 && Date.now() - started < 600_000) {
      const at = Date.now();
      const result = await paySouvenirs({ pool: f.pool }, { eventId: f.ids.eventA });
      batches.push({ elapsedMs: Date.now() - at, ...result });
      due = Number(
        (
          await f.db.owner.query("SELECT count(*) AS n FROM souvenir_work WHERE event_id=$1", [
            f.ids.eventA,
          ])
        ).rows[0].n,
      );
    }
    const owned = Number(
      (
        await f.db.owner.query("SELECT count(*) AS n FROM souvenir_receipt WHERE rule_id=$1", [
          rule,
        ])
      ).rows[0].n,
    );
    const result = {
      recipients: 20001,
      sourceMs,
      elapsedMs: Date.now() - started,
      owned,
      due,
      batches,
      maxRecipientsPerPass: Math.max(...batches.map((b) => b.granted + b.skipped + b.failed)),
    };
    const report = process.env["SOUVENIR_BENCH_REPORT"];
    if (report !== undefined) await writeFile(report, JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify({ ...result, batches: batches.length })}\n`);
    if (owned !== 20001 || due !== 0 || result.maxRecipientsPerPass > 500)
      throw new Error("souvenir benchmark did not converge within its bounds");
  } finally {
    await f.close();
  }
}
await measure();
