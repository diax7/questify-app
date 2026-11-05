import type { FastifyRequest } from "fastify";
import { unauthenticated } from "#src/auth/http-errors";
import type { OrganizerContext, OrganizerPrincipal } from "#src/organizers/store";
import type { Actor } from "#src/organizers/team";

/** The caller and the organizer they are a member of; only reachable after the organizer scope's hook. */
export function organizerContextOf(
  request: FastifyRequest,
): OrganizerContext & { email: string; organizer: OrganizerPrincipal } {
  const staff = request.staff;
  const organizer = request.organizer;
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: unreachable: the scope's hook sets both or answers
  if (staff === undefined || organizer === undefined) {
    // Reached only if the scope's hook was bypassed, which must never answer a request.
    throw unauthenticated();
  }
  return {
    staffUserId: staff.account.id,
    organizerId: organizer.id,
    email: staff.account.email,
    organizer,
    // A support view (T-712, ADR-521): every seat built from this context opens its transaction READ ONLY.
    ...(organizer.readOnly === true ? { readOnly: true } : {}),
  };
}

/** The caller as the team's actor: carries the support-view mark like the context, so a seat built from it stays read-only. */
export function actorOf(request: FastifyRequest): Actor {
  const context = organizerContextOf(request);
  return {
    organizerId: context.organizerId,
    staffUserId: context.staffUserId,
    email: context.email,
    ...(context.readOnly === true ? { readOnly: true } : {}),
  };
}
