import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { VENUE_RADIUS, readBranding, readEventTerms } from "@questify/shared";
import {
  eventNotDraft,
  eventNotEmpty,
  eventNotLive,
  eventArchived,
  eventCityLocked,
  eventTimesLocked,
  featureNotAllowed,
  invalidBranding,
  invalidEvent,
  invalidLayout,
  invalidTerms,
  invalidTexts,
  layoutItemProtected,
  notFound,
  rehearsalData,
  scopeLimited,
  souvenirData,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import type {
  DuplicateResult,
  EndResult,
  Events,
  RemoveResult,
  StartResult,
  UpdateResult,
} from "#src/events/events";
import type { EventRecord } from "#src/events/store";
import { organizerContextOf } from "#src/organizers/context";
import type { SettingsService } from "#src/settings/service";

const BODY_LIMIT = 8192;
// The layout carries the Home and info page words in both languages: about 72 KB when every field is full (ADR-398).
const LAYOUT_BODY_LIMIT = 160 * 1024;

/** The event's wall clock, read in its zone: no seconds, no `Z`, no offset. */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const bilingual = (max: number) =>
  z.strictObject({ ar: z.string().max(max).optional(), en: z.string().max(max).optional() });

// Strict: a field the API never writes (status, join code) is refused, not silently dropped.
const eventFields = {
  name: bilingual(120).optional(),
  kind: z.enum(["physical", "virtual", "workplace"]).optional(),
  venue: bilingual(200).optional(),
  access: z.enum(["public", "unlisted", "private"]).optional(),
  joinMethods: z
    .array(z.enum(["code", "qr", "link", "public_list"]))
    // An empty list reaches merge, which names the field (422 joinMethods) rather than a bare 400.
    .max(4)
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  dayStartHour: z.number().int().min(0).max(23).optional(),
  startsAt: localTime.optional(),
  endsAt: localTime.optional(),
  // The venue's pin for the far-from-venue flag (T-303b); null clears it.
  venuePin: z
    .strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .nullable()
    .optional(),
  venueRadiusM: z.number().int().min(VENUE_RADIUS.min).max(VENUE_RADIUS.max).optional(),
  // A city id from GET /v1/cities (T-403); null clears it. An unknown id answers invalid_event { field: cityId }.
  cityId: z
    .string()
    .regex(/^sa-[a-z0-9-]{2,30}$/)
    .nullable()
    .optional(),
  // Up to 3 interest ids from GET /v1/interests (T-407); more, repeats or unknown ids answer invalid_event { field: interests }.
  interests: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{1,29}$/))
    .max(10)
    .optional(),
};
// A template's key (T-601b); the database holds the same shape.
const templateKey = z.string().regex(/^[a-z][a-z0-9_]{1,29}$/);
const patchBody = z.strictObject(eventFields);
const createBody = z.strictObject({
  ...eventFields,
  startsAt: localTime,
  endsAt: localTime,
  template: templateKey.optional(),
});
const templateBody = z.strictObject({ template: templateKey });
// A duplicate takes only what must differ: the new name and times. The rest is the source's.
const duplicateBody = z.strictObject({
  name: bilingual(120),
  startsAt: localTime,
  endsAt: localTime,
});
const endBody = z.strictObject({ confirm: z.literal(true) });
const rankingBody = z.strictObject({ enabled: z.boolean() });
const eventParams = z.object({ eventId: z.uuid() });

const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;
const layoutWriter = { ...member, bodyLimit: LAYOUT_BODY_LIMIT } as const;

/** What the dashboard sees of an event: instants as UTC ISO, the zone to show them in. */
const view = (event: EventRecord) => ({
  id: event.id,
  joinCode: event.joinCode,
  name: event.name,
  kind: event.kind,
  venue: event.venue,
  access: event.access,
  joinMethods: event.joinMethods,
  timezone: event.timezone,
  dayStartHour: event.dayStartHour,
  startsAt: event.startsAt?.toISOString() ?? null,
  endsAt: event.endsAt?.toISOString() ?? null,
  status: event.status,
  statusNow: event.statusNow,
  createdAt: event.createdAt.toISOString(),
  ranking: event.rankingOn,
  rankingToday: event.rankingTodayOn,
  shareQuests: event.shareQuestsOn,
  meetSomeone: event.meetSomeoneOn,
  miniGames: event.miniGamesOn,
  community: event.communityOn,
  flashQuests: event.flashQuestsOn,
  boosts: event.boostsOn,
  helpDesk: event.helpDeskOn,
  questRatings: event.questRatingsOn,
  shop: event.shopOn,
  polls: event.pollsOn,
  maps: event.mapsOn,
  agenda: event.agendaOn,
  branding: event.branding,
  layout: event.layout,
  venuePin: event.venuePin,
  venueRadiusM: event.venueRadiusM,
  cityId: event.cityId,
  interests: event.interests,
});

function answerCreate(reply: FastifyReply, result: DuplicateResult) {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "created":
      return reply.code(201).send({ event: view(result.event) });
    case "invalid":
      throw invalidEvent({ field: result.field });
    case "scope_limited":
      throw scopeLimited();
  }
}

function answerStart(result: StartResult) {
  switch (result.kind) {
    case "started":
      return { event: view(result.event) };
    case "invalid":
      throw invalidEvent({ field: result.field });
    case "not_found":
      throw notFound();
    case "not_empty":
      throw eventNotEmpty();
  }
}

function answerUpdate(result: UpdateResult) {
  switch (result.kind) {
    case "updated":
      return { event: view(result.event) };
    case "invalid":
      throw invalidEvent({ field: result.field });
    case "not_found":
      throw notFound();
    case "times_locked":
      throw eventTimesLocked();
    case "city_locked":
      throw eventCityLocked();
  }
}

function answerGone(reply: FastifyReply, result: RemoveResult | EndResult) {
  switch (result.kind) {
    case "deleted":
    case "ended":
      return reply.code(204).send();
    case "not_found":
      throw notFound();
    case "not_draft":
      throw eventNotDraft();
    case "not_live":
      throw eventNotLive();
    case "rehearsal_data":
      throw rehearsalData();
    case "souvenir_data":
      throw souvenirData();
  }
}

/** FR-1015: the templates the new-event page and the guided setup's "Start from" offer, and filling an empty draft from one. */
function registerTemplateRoutes(scope: FastifyInstance, events: Events): void {
  // The picker's view of each template, from the event_template rows.
  scope.get("/event-templates", member, async (request) => ({
    templates: await events.templates(organizerContextOf(request)),
  }));

  // An empty draft takes a template; anything else is 409 event_not_empty.
  scope.post(
    "/events/:eventId/template",
    { ...member, config: { ...member.config, idempotent: true } },
    async (request) => {
      const { eventId } = parse(eventParams, request.params);
      const body = parse(templateBody, request.body);
      return answerStart(
        await events.startFromTemplate(
          organizerContextOf(request),
          eventId,
          body.template,
          callerOf(request),
        ),
      );
    },
  );
}

/**
 * The event builder's routes, registered inside the organizer scope (its hook has already checked the session and
 * the membership). An editor limited to chosen events sees only those: the database applies the limit.
 */
export function registerEventRoutes(
  scope: FastifyInstance,
  events: Events,
  settings: SettingsService,
): void {
  registerTemplateRoutes(scope, events);

  scope.get("/events", member, async (request) => {
    const list = await events.list(organizerContextOf(request));
    return { events: list.map(view) };
  });

  // A double click must not make two events: the Idempotency-Key replays the first answer.
  scope.post(
    "/events",
    { ...member, config: { ...member.config, idempotent: true } },
    async (request, reply) => {
      const body = parse(createBody, request.body);
      return answerCreate(
        reply,
        await events.create(organizerContextOf(request), body, callerOf(request)),
      );
    },
  );

  // FR-1016: a new Draft with the source's setup, never its players, points, prizes handed over, codes or secrets.
  scope.post(
    "/events/:eventId/duplicate",
    { ...member, config: { ...member.config, idempotent: true } },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const body = parse(duplicateBody, request.body);
      return answerCreate(
        reply,
        await events.duplicate(organizerContextOf(request), eventId, body, callerOf(request)),
      );
    },
  );

  // The single read alone carries the event's words and renamed labels: the event page's form and the labels page edit them.
  scope.get("/events/:eventId", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const event = await events.get(organizerContextOf(request), eventId);
    if (event === undefined) {
      throw notFound();
    }
    return {
      event: {
        ...view(event),
        terms: event.terms,
        texts: event.texts,
        suspension: event.suspension,
      },
    };
  });

  scope.patch("/events/:eventId", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(patchBody, request.body);
    return answerUpdate(
      await events.update(organizerContextOf(request), eventId, body, callerOf(request)),
    );
  });

  scope.delete("/events/:eventId", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    return answerGone(
      reply,
      await events.remove(organizerContextOf(request), eventId, callerOf(request)),
    );
  });

  // The dashboard asks the owner to confirm; the body says they did.
  scope.post("/events/:eventId/end", owner, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    parse(endBody, request.body);
    return answerGone(
      reply,
      await events.endEarly(organizerContextOf(request), eventId, callerOf(request)),
    );
  });

  // FR-404, FR-405, FR-940: the event's currency and renamed words. The body is the whole form; a word left out
  // returns to the default. The shared schema checks it, so a missing form is named (422 with the field).
  scope.put("/events/:eventId/terms", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const context = organizerContextOf(request);
    const saved = await settings.saveEventTerms(context, eventId, request.body, {
      requestId: request.id,
    });
    if (saved.ok) {
      // The body passed the strict check, so the tolerant read gives exactly what was stored, trimmed, defaults filled.
      return { terms: readEventTerms(request.body) };
    }
    switch (saved.reason) {
      case "invalid":
        throw invalidTerms({ field: saved.issues[0]?.path });
      case "archived":
        throw eventArchived();
      default:
        throw notFound();
    }
  });
  registerEventBranding(scope, settings);
  registerEventLayout(scope, settings);
  registerEventTexts(scope, settings);
  registerEventSwitches(scope, settings);
}

/**
 * FR-1749, FR-1750, FR-1764: the event's bar and Home layout, as one of the team's approved presets by name or as the order
 * and hidden set of each list. Owners and editors. Home, the scan button, Profile and the protected Home blocks cannot be
 * hidden (422 `layout_item_protected` names the item), and the check is the server's whatever the dashboard sends.
 */
function registerEventLayout(scope: FastifyInstance, settings: SettingsService): void {
  scope.put("/events/:eventId/layout", layoutWriter, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const context = organizerContextOf(request);
    const saved = await settings.saveEventLayout(context, eventId, request.body, {
      requestId: request.id,
    });
    if (saved.ok) {
      return { layout: saved.layout };
    }
    switch (saved.reason) {
      case "invalid": {
        const blocked = saved.issues.find((issue) => issue.protectedItem !== undefined);
        if (blocked?.protectedItem !== undefined) {
          throw layoutItemProtected({ item: blocked.protectedItem, field: blocked.path });
        }
        throw invalidLayout({ field: saved.issues[0]?.path });
      }
      case "archived":
        throw eventArchived();
      default:
        throw notFound();
    }
  });
}

/**
 * FR-1843: the labels the event renamed (the bar's names, which the screens and the shop also use), in Arabic and English.
 * Owners and editors in scope. Only the approved labels are accepted, cleaned and bounded, with their placeholders kept
 * (422 `invalid_texts` names the label); a blank label returns to the platform's text. The body is the whole set.
 */
function registerEventTexts(scope: FastifyInstance, settings: SettingsService): void {
  scope.put("/events/:eventId/texts", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const context = organizerContextOf(request);
    const saved = await settings.saveEventTexts(context, eventId, request.body, {
      requestId: request.id,
    });
    if (saved.ok) {
      return { texts: saved.texts };
    }
    switch (saved.reason) {
      case "invalid":
        throw invalidTexts({ field: saved.issues[0]?.path });
      case "archived":
        throw eventArchived();
      default:
        throw notFound();
    }
  });
}

/** FR-1023: the event's accent colour, one of the curated list or null for the brand colour. Owners and editors. */
function registerEventBranding(scope: FastifyInstance, settings: SettingsService): void {
  scope.put("/events/:eventId/branding", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const context = organizerContextOf(request);
    const saved = await settings.saveEventBranding(context, eventId, request.body, {
      requestId: request.id,
    });
    if (saved.ok) {
      return { branding: readBranding(request.body) };
    }
    switch (saved.reason) {
      case "invalid":
        throw invalidBranding({ field: saved.issues[0]?.path });
      case "archived":
        throw eventArchived();
      default:
        throw notFound();
    }
  });
}

/**
 * FR-607, FR-608, FR-219, FR-1009 and F-101: the owner turns the event's ranking, today's ranking, share and meet
 * quests, mini-games and community quests off and on; the event's other switches stay as they are. Community off
 * finishes the event's running goals (migration 0053's trigger, ADR-226). Flash quests off hides every one at once;
 * boosts off stops every boost paying at once (T-307, migration 0055). Help desk off stops new tickets (T-310). Quest
 * ratings are the one switch that starts off: players are asked only after the owner turns them on (T-508, FR-1623).
 * Cheers off ends any live moment at once and refuses a new one (T-509, FR-1841). The shop, live polls, maps and agenda
 * (T-602, FR-1009) go off the player's side at once: the Rewards tab and the shop's doors, the live poll cards, the map
 * and the agenda; the team's own pages and every record stay.
 */
function registerEventSwitches(scope: FastifyInstance, settings: SettingsService): void {
  const switches = [
    ["/events/:eventId/ranking", "ranking"],
    ["/events/:eventId/ranking-today", "rankingToday"],
    ["/events/:eventId/share-quests", "shareQuests"],
    ["/events/:eventId/meet-someone", "meetSomeone"],
    ["/events/:eventId/mini-games", "miniGames"],
    ["/events/:eventId/community", "community"],
    ["/events/:eventId/flash-quests", "flashQuests"],
    ["/events/:eventId/double-points", "boosts"],
    ["/events/:eventId/help-desk", "helpDesk"],
    ["/events/:eventId/quest-ratings", "questRatings"],
    ["/events/:eventId/cheers", "cheers"],
    ["/events/:eventId/features/shop", "shop"],
    ["/events/:eventId/features/polls", "polls"],
    ["/events/:eventId/features/maps", "maps"],
    ["/events/:eventId/features/agenda", "agenda"],
  ] as const;
  const save = async (
    request: FastifyRequest,
    eventId: string,
    feature: string,
  ): Promise<Record<string, boolean>> => {
    const { enabled } = parse(rankingBody, request.body);
    const context = organizerContextOf(request);
    const saved = await settings.saveEventSwitch(context, eventId, feature, enabled, {
      requestId: request.id,
    });
    if (saved.ok) {
      return { [feature]: enabled };
    }
    // The platform, Questify's override for this organizer or the add-on rule keeps the feature off (FR-1826, FR-1827).
    throw saved.reason === "not_allowed" ? featureNotAllowed() : notFound();
  };
  for (const [path, feature] of switches) {
    scope.put(path, owner, async (request) => {
      const { eventId } = parse(eventParams, request.params);
      return save(request, eventId, feature);
    });
  }

  // The features the platform leaves on for this organizer, each on, off or locked (FR-1826, FR-1827).
  scope.get("/events/:eventId/features", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const layers = await settings.eventLayers(organizerContextOf(request), eventId);
    if (layers === undefined) {
      throw notFound();
    }
    return layers;
  });
}
