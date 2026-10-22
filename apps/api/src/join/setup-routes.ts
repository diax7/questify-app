import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  eventArchived,
  guestListFull,
  invalidRequest,
  joinFieldsChanged,
  notFound,
  settingLocked,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { JOIN_FIELD_KINDS } from "@questify/shared";
import {
  DOMAIN_LIMIT,
  GUESTS_PER_UPLOAD,
  JOIN_FIELD_LIMIT,
  addGuests,
  listGuests,
  readSetup,
  removeGuest,
  saveFields,
  updateRules,
  type SetupDeps,
  type SetupDone,
} from "#src/join/setup";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });
const guestParams = z.object({ eventId: z.uuid(), guestId: z.uuid() });
const label = z.strictObject({
  ar: z.string().max(120).optional(),
  en: z.string().max(120).optional(),
});
const fieldsBody = z.strictObject({
  version: z.number().int().min(0),
  fields: z
    .array(
      z.strictObject({
        id: z.uuid().optional(),
        kind: z.enum(JOIN_FIELD_KINDS),
        label: label.optional(),
        required: z.boolean(),
      }),
    )
    .max(JOIN_FIELD_LIMIT),
});
const rulesBody = z.strictObject({
  guestListOnly: z.boolean().optional(),
  emailDomains: z
    .array(z.string().max(260))
    .max(DOMAIN_LIMIT * 2)
    .optional(),
  welcomePoints: z.number().int().min(1).max(100_000).nullable().optional(),
});
const guestsBody = z.strictObject({
  lines: z.array(z.string().max(300)).min(1).max(GUESTS_PER_UPLOAD),
});

const member = { config: { access: "member" }, bodyLimit: 16_384 } as const;
/** 2 000 lines of up to 300 characters of JSON each, with room for the envelope. */
const GUESTS_BODY_LIMIT = 700_000;

function answer<T>(result: SetupDone<T>, ok: (value: T) => unknown): unknown {
  switch (result.kind) {
    case "done":
      return ok(result.value);
    case "not_found":
      throw notFound();
    case "event_archived":
      throw eventArchived();
    case "setting_locked":
      throw settingLocked();
    case "fields_changed":
      throw joinFieldsChanged();
    case "invalid":
      throw invalidRequest({ field: result.field });
    case "guest_list_full":
      throw guestListFull({ room: result.room });
  }
}

/**
 * The dashboard's join setup (T-212), for owners and editors: `GET …/events/:eventId/join` (fields, locks, welcome,
 * the guest count), `PUT …/join/fields` (the whole list with the version read), `PUT …/join/rules`, and the guest list
 * at `GET`/`POST …/join/guests` and `DELETE …/join/guests/:guestId`.
 */
export function registerJoinSetupRoutes(scope: FastifyInstance, deps: SetupDeps): void {
  scope.get("/events/:eventId/join", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return answer(await readSetup(deps, organizerContextOf(request), eventId), (setup) => setup);
  });

  scope.put("/events/:eventId/join/fields", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(fieldsBody, request.body);
    const result = await saveFields(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, (saved) => saved);
  });

  scope.put("/events/:eventId/join/rules", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(rulesBody, request.body);
    const result = await updateRules(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, (rules) => ({ rules }));
  });

  scope.get("/events/:eventId/join/guests", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return answer(await listGuests(deps, organizerContextOf(request), eventId), (list) => list);
  });

  scope.post(
    "/events/:eventId/join/guests",
    { ...member, bodyLimit: GUESTS_BODY_LIMIT },
    async (request) => {
      const { eventId } = parse(eventParams, request.params);
      const body = parse(guestsBody, request.body);
      const result = await addGuests(
        deps,
        organizerContextOf(request),
        eventId,
        body.lines,
        callerOf(request),
      );
      return answer(result, (added) => added);
    },
  );

  scope.delete("/events/:eventId/join/guests/:guestId", member, async (request, reply) => {
    const { eventId, guestId } = parse(guestParams, request.params);
    const result = await removeGuest(
      deps,
      organizerContextOf(request),
      { eventId, id: guestId },
      callerOf(request),
    );
    return answer(result, () => reply.code(204).send());
  });
}
