// Ledger pre-check for scripts/cranl/deploy-staging-gated.sh: runs inside the API container with DATABASE_ADMIN_URL and
// prints one line, mismatch=<n>, counting ledger rows whose event is not their quest's (must be 0 before migrating).
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  const r = await c.query(
    "SELECT count(*)::int AS n FROM ledger_entry l JOIN quest q ON q.id = l.quest_id WHERE q.event_id <> l.event_id",
  );
  process.stdout.write(`mismatch=${r.rows[0].n}\n`);
  await c.end();
})().catch((e) => process.stdout.write(`count-failed ${e.code || e.name}\n`));
