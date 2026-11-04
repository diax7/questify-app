/** Runs one statement as the migration owner (each suite's own helper). */
type Owner = (sql: string, values?: unknown[]) => Promise<unknown>;

/** The seeded platform send budget (migration 0150): Q-093's numbers, which the tests put back. */
export const SEEDED_SEND_BUDGET = { phone: 5000, email: 1000 } as const;

/**
 * Sets a channel's platform send budget to `cap` as the owner (the RUNBOOK's UPDATE, so a lower cap settles as in
 * production), runs `work`, then puts the seeded number back, settled. A cap of 0 is a spent budget.
 */
export async function withSendBudgetCap<T>(
  owner: Owner,
  channel: "phone" | "email",
  cap: number,
  work: () => Promise<T>,
): Promise<T> {
  await owner("UPDATE platform_send_budget SET cap = $2 WHERE channel = $1", [channel, cap]);
  try {
    return await work();
  } finally {
    await setSendBudget(owner, channel, SEEDED_SEND_BUDGET[channel]);
  }
}

/**
 * Sets a channel's cap and clears the settling mark the trigger stamps on a lower cap (a second statement: the trigger
 * runs after the SET of the first). Only for tests that control every row of the budget's window.
 */
export async function setSendBudget(
  owner: Owner,
  channel: "phone" | "email",
  cap: number,
): Promise<void> {
  await owner("UPDATE platform_send_budget SET cap = $2 WHERE channel = $1", [channel, cap]);
  await owner("UPDATE platform_send_budget SET changed_at = '-infinity' WHERE channel = $1", [
    channel,
  ]);
}

/** The units of a channel's platform budget used in the last day, across its 16 stripes (migration 0150). */
export const SEND_BUDGET_USED_SQL = `SELECT count(*)::int AS n FROM auth_throttle
  WHERE bucket = CASE $1 WHEN 'phone' THEN 'sms_platform' ELSE 'player_email_platform' END
    AND key IN (SELECT sha256(convert_to(CASE $1 WHEN 'phone' THEN 'questify.sms_platform.'
                                         ELSE 'questify.player_email_platform.' END || i, 'UTF8'))
                FROM generate_series(0, 15) AS i)
    AND at > now() - interval '1 day'`;
