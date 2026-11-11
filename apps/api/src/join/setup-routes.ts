import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  eventArchived,
  guestListFull,
  invalidRequest,
  joinFieldInUse,
  fullNameFieldInUse,
  joinFieldsChanged,
  nameDisplayLocked,
  nameDisplayNeedsField,
  notFound,
  settingLocked,
} from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { callerOf, parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { holdBack, type DeviceLimit } from "#src/devices/limits";
import { JOIN_FIELD_KINDS, JOIN_OPTION_MAX, NAME_AUDIENCES, NAME_DISPLAYS } from "@questify/shared";
import { updateNames } from "#src/join/names";
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

/**
 * Contact probes of the guest list per team member (audit hardening, w2-flows 1): `?contact=` confirms a full phone or
 * email against the masked list, so a member cannot try the ten thousand endings of a masked number. Finding one older
 * guest to remove takes a probe or two; a sweep of the number space does not fit.
 */
export const GUEST_PROBE_LIMIT: DeviceLimit = {
  bucket: BUCKETS.guestContactProbe,
  max: 30,
  windowSeconds: 3600,
};

const eventParams = z.object({ eventId: z.uuid() });
const guestQuery = z.strictObject({ contact: z.string().max(320).optional() });
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
        options: z
          .array(
            z.strictObject({
              id: z.string().max(12).optional(),
              ar: z.string().max(120).optional(),
              en: z.string().max(120).optional(),
            }),
          )
          .max(JOIN_OPTION_MAX)
          .nullable()
          .optional(),
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
const namesBody = z.strictObject({
  display: z.enum(NAME_DISPLAYS),
  audience: z.enum(NAME_AUDIENCES),
});
const guestsBody = z.strictObject({
  lines: z.array(z.string().max(300)).min(1).max(GUESTS_PER_UPLOAD),
  // ADR-172: one tag for the whole upload (targeting); a tagged contact is on the guest list, so it is invited.
  tag: z.string().max(60).optional(),
});

const member = { config: { access: "member" }, bodyLimit: 16_384 } as const;
/** 2 000 lines of up to 300 characters of JSON each, with room for the envelope. */
const GUESTS_BODY_LIMIT = 700_000;

/** The refusals that carry nothing from the result. */
const PLAIN_REFUSALS = {
  not_found: notFound,
  event_archived: eventArchived,
  setting_locked: settingLocked,
  fields_changed: joinFieldsChanged,
  name_display_locked: nameDisplayLocked,
  needs_full_name_field: nameDisplayNeedsField,
  full_name_field_in_use: fullNameFieldInUse,
} as const;

function answer<T>(result: SetupDone<T>, ok: (value: T) => unknown): unknown {
  switch (result.kind) {
    case "done":
      return ok(result.value);
    case "invalid":
      throw invalidRequest({ field: result.field });
    case "guest_list_full":
      throw guestListFull({ room: result.room });
    case "field_in_use":
      throw joinFieldInUse({ ...result.inUse });
    default:
      throw PLAIN_REFUSALS[result.kind]();
  }
}

/**
 * The dashboard's join setup (T-212), for owners and editors: `GET …/events/:eventId/join` (fields, locks, welcome,
 * names, the guest count), `PUT …/join/fields` (the whole list with the version read), `PUT …/join/rules`,
 * `PUT …/join/names` (how players are named and who sees a full name, T-615), and the guest list
 * at `GET`/`POST …/join/guests` and `DELETE …/join/guests/:guestId`.
 */
export function registerJoinSetupRoutes(
  scope: FastifyInstance,
  deps: SetupDeps & Readonly<{ keys: Pick<AuthKeys, "userKey"> }>,
): void {
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

  scope.put("/events/:eventId/join/names", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(namesBody, request.body);
    const result = await updateNames(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, (names) => ({ names }));
  });

  scope.get("/events/:eventId/join/guests", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { contact } = parse(guestQuery, request.query);
    const context = organizerContextOf(request);
    if (contact !== undefined) {
      const key = deps.keys.userKey(`${BUCKETS.guestContactProbe}:${context.staffUserId}`);
      await holdBack(deps.pool, [{ limit: GUEST_PROBE_LIMIT, key }], true, reply);
    }
    return answer(await listGuests(deps, context, eventId, contact), (list) => list);
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
        body,
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
