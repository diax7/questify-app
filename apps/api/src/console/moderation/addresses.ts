import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { invalidModerationAddress } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { door, type Admin } from "#src/console/doors";
import {
  CONSOLE_MODERATION_LIMIT,
  CONSOLE_REPORTS_READ_LIMIT,
} from "#src/console/moderation/routes";
import { throttled, type ConsolePlayerDeps } from "#src/console/players/routes";

/** The moderation addresses (ADR-495): where urgent-report alerts go and the address a banned player appeals to. */
export type ModerationAddresses = Readonly<{
  alertEmail: string | null;
  appealEmail: string | null;
  /** Used for either one while it is unset (`MAIL_FROM`). */
  sendingAddress: string;
}>;

export type ModerationAddressDeps = ConsolePlayerDeps & Readonly<{ mailFrom: string }>;

const address = z.string().trim().max(254).nullable();
const body = z.strictObject({ alertEmail: address, appealEmail: address });

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The `moderation` key's two addresses as stored (the platform settings are readable by the API's role). */
export async function readModerationAddresses(
  pool: Pool,
): Promise<Readonly<{ alertEmail: string | null; appealEmail: string | null }>> {
  const { rows } = await pool.query<{ value: Record<string, unknown> }>(
    "SELECT value FROM platform_setting WHERE key = 'moderation'",
  );
  const value = rows[0]?.value ?? {};
  return { alertEmail: text(value["alertEmail"]), appealEmail: text(value["appealEmail"]) };
}

async function writeAddresses(
  pool: Pool,
  admin: Admin,
  input: Readonly<{ alertEmail: string | null; appealEmail: string | null }>,
  requestId: string,
): Promise<void> {
  try {
    await door(pool, admin, (client) =>
      client.query("SELECT admin_set_moderation_addresses($1, $2, $3)", [
        input.alertEmail,
        input.appealEmail,
        requestId,
      ]),
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === "MA422") throw invalidModerationAddress();
    throw error;
  }
}

/**
 * The Reports page's Moderation addresses card (T-701b, ADR-495): read both addresses with the sending address they
 * fall back to, and set them through `admin_set_moderation_addresses` (audited before and after). Inside the console
 * scope.
 */
export function registerModerationAddressRoutes(
  scope: FastifyInstance,
  deps: ModerationAddressDeps,
): void {
  scope.get(
    "/moderation-addresses",
    { config: { access: "admin" }, bodyLimit: 1024 },
    async (request, reply) => {
      await throttled(deps, request, reply, CONSOLE_REPORTS_READ_LIMIT);
      return {
        ...(await readModerationAddresses(deps.pool)),
        sendingAddress: deps.mailFrom,
      } satisfies ModerationAddresses;
    },
  );

  scope.put(
    "/moderation-addresses",
    { config: { access: "admin", idempotent: true }, bodyLimit: 2048 },
    async (request, reply) => {
      const input = parse(body, request.body);
      const who = await throttled(deps, request, reply, CONSOLE_MODERATION_LIMIT);
      await writeAddresses(deps.pool, who, input, request.id);
      return {
        ...(await readModerationAddresses(deps.pool)),
        sendingAddress: deps.mailFrom,
      } satisfies ModerationAddresses;
    },
  );
}
