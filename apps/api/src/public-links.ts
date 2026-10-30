import type { FastifyInstance } from "fastify";
import type { AuthKeys } from "#src/auth/keys";
import type { InvitationDeps } from "#src/invitation-campaigns/campaigns";
import { registerInvitationOpenRoute } from "#src/invitation-campaigns/routes";
import { registerSurveyResultsOpenRoute } from "#src/ratings/routes";

/**
 * The anonymous doors a link opens: an invitation's landing page (T-409b) and a speaker's survey results (T-508). Each
 * reads one bearer token from the body, counts the try against the address before reading it, and answers only what the
 * token names.
 */
export function registerPublicLinkRoutes(
  app: FastifyInstance,
  deps: Readonly<{ pool: InvitationDeps["pool"]; keys: Pick<AuthKeys, "addressKey"> }>,
): void {
  registerInvitationOpenRoute(app, deps);
  registerSurveyResultsOpenRoute(app, deps);
}
