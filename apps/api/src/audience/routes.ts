import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  readAudience,
  setAudience,
  type AudienceDeps,
  type ItemKind,
} from "#src/audience/audience";
import type { AudienceRule } from "#src/audience/rules";
import { eventArchived, invalidAudience, notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });
const itemParams = z.object({ eventId: z.uuid(), itemId: z.uuid() });
const values = z.array(z.string().max(60)).min(1).max(20);
const ruleBody = z.strictObject({
  rule: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("answer"), fieldId: z.uuid(), values }),
      z.strictObject({ kind: z.literal("tag"), values }),
    ])
    .nullable(),
});

const member = { config: { access: "member" } } as const;

/**
 * Targeting (T-220, FR-1708, ADR-170) for the event's owner and editors in scope: `GET …/events/:eventId/audience`
 * (choice fields, guest tags, every category and reward with its rule and reach) and `PUT …/audience/categories/:id`
 * or `…/audience/rewards/:id` with `{rule}` (null for everyone). The database checks the caller, the event lock and
 * the options again, and audits ids and counts only.
 */
export function registerAudienceRoutes(scope: FastifyInstance, deps: AudienceDeps): void {
  scope.get("/events/:eventId/audience", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const view = await readAudience(deps, organizerContextOf(request), eventId);
    if (view === null) {
      throw notFound();
    }
    return view;
  });

  for (const [path, kind] of [
    ["categories", "category"],
    ["rewards", "reward"],
  ] as const satisfies readonly (readonly [string, ItemKind])[]) {
    scope.put(`/events/:eventId/audience/${path}/:itemId`, member, async (request) => {
      const { eventId, itemId } = parse(itemParams, request.params);
      const { rule } = parse(ruleBody, request.body);
      const outcome = await setAudience(deps, organizerContextOf(request), {
        eventId,
        kind,
        itemId,
        rule: rule as AudienceRule | null,
        requestId: request.id,
      });
      switch (outcome.kind) {
        case "done":
          return { item: outcome.item };
        case "not_found":
          throw notFound();
        case "archived":
          throw eventArchived();
        case "invalid":
          throw invalidAudience();
      }
    });
  }
}
