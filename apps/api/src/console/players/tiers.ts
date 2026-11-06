import { PLAYER_NOTE_MAX, tierChangeListSchema, type TierChange } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  invalidPlayerAction,
  notBanned,
  tierAlreadyRevoked,
  tierNotEarned,
  tierNotRevoked,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { door, type Admin } from "#src/console/doors";
import {
  CONSOLE_PLAYER_CHANGE_LIMIT,
  reasonOf,
  type ConsolePlayerDeps,
} from "#src/console/players/routes";
import { throttled } from "#src/console/throttle";
import type { ActionReason } from "#src/console/players/doors";
import type { HttpError } from "#src/http-error";

type TierAction = "revoke" | "restore";

const TIER_SQL: Readonly<Record<TierAction, string>> = {
  revoke: "SELECT * FROM admin_revoke_tiers($1, $2, $3, $4, $5)",
  restore: "SELECT * FROM admin_restore_tiers($1, $2, $3, $4, $5)",
};
const TIER_REFUSALS: Readonly<Record<string, () => HttpError>> = {
  not_banned: notBanned,
  not_earned: tierNotEarned,
  already_revoked: tierAlreadyRevoked,
  not_revoked: tierNotRevoked,
};

/**
 * Revokes or restores earned achievement tiers of one player (T-709c, ADR-439). The earned rows and XP entries stay: a
 * revoked tier is hidden and its item is not given; a restore shows it again and the next sync gives the item.
 * Only a banned player's tiers can be revoked; a restore needs no ban. The door locks the player, then its XP row (the
 * sync's order), and audits with ids and tiers only.
 *
 * @throws HttpError not_banned, tier_not_earned, tier_already_revoked, tier_not_revoked (409); 404 for an unknown or
 *   erased player; invalid_player_action for a bad reason or tier list.
 */
export function changeTiers(
  pool: Pool,
  admin: Admin,
  input: ActionReason &
    Readonly<{ playerId: string; tiers: readonly TierChange[]; action: TierAction }>,
  requestId: string,
): Promise<string> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ outcome: string; action_id: string | null }>(
      TIER_SQL[input.action],
      [input.playerId, JSON.stringify(input.tiers), input.reasonCode, input.note, requestId],
    );
    const row = rows[0];
    if (row?.action_id !== null && row?.action_id !== undefined) {
      return row.action_id;
    }
    const refusal = TIER_REFUSALS[row?.outcome ?? ""];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the doors answer one of the outcomes
    if (refusal === undefined) {
      throw new Error("the tier door gave an unknown outcome; check migration 0122");
    }
    throw refusal();
  });
}

const change = { config: { access: "admin", idempotent: true }, bodyLimit: 8192 } as const;
const playerParams = z.object({ playerId: z.uuid() });
const tiersBody = z.strictObject({
  tiers: z.unknown(),
  reasonCode: z.string().max(32),
  note: z.string().max(PLAYER_NOTE_MAX * 4),
});

/** The body's tiers and reason, checked before the door checks them again. */
function tierInput(action: TierAction, body: unknown) {
  const { tiers, reasonCode, note } = parse(tiersBody, body);
  const reason = reasonOf(action === "revoke" ? "revoke_tiers" : "restore_tiers", {
    reasonCode,
    note,
  });
  const checked = tierChangeListSchema.safeParse(tiers);
  if (!checked.success) {
    throw invalidPlayerAction();
  }
  return { ...reason, tiers: checked.data };
}

/**
 * `POST /players/:playerId/achievement-tiers/revoke` and `…/restore` (T-709c): `{tiers, reasonCode, note}`, an
 * Idempotency-Key, and the player-change bucket (30 an hour per admin). Inside the console scope, whose hook answers 404
 * to anyone but an active platform admin.
 */
export function registerConsoleTierRoutes(scope: FastifyInstance, deps: ConsolePlayerDeps): void {
  for (const action of ["revoke", "restore"] as const) {
    scope.post(`/players/:playerId/achievement-tiers/${action}`, change, async (request, reply) => {
      const { playerId } = parse(playerParams, request.params);
      const input = tierInput(action, request.body);
      const who = await throttled(deps, request, reply, CONSOLE_PLAYER_CHANGE_LIMIT);
      const actionId = await changeTiers(
        deps.pool,
        who,
        { ...input, playerId, action },
        request.id,
      );
      return { actionId };
    });
  }
}
