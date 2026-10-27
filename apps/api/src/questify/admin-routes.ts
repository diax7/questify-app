import {
  INTERESTS_METRIC,
  campaignBodySchema,
  questBodySchema,
  questPatchSchema,
  questifyMonthSchema,
  type CampaignBody,
  type QuestPatch,
} from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { invalidQuestify, notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  listQuestify,
  listSeasons,
  publishCampaign,
  readSeason,
  retireCampaign,
  retireQuest,
  saveCampaign,
  saveQuest,
} from "#src/questify/admin";

const BODY_LIMIT = 8192;
const read = { config: { access: "admin" }, bodyLimit: BODY_LIMIT } as const;
const write = { ...read, config: { ...read.config, idempotent: true } } as const;
const campaignParams = z.object({ campaignId: z.uuid() });
const questParams = z.object({ questId: z.uuid() });
const seasonParams = z.object({ month: questifyMonthSchema });

/** The admin of a request that passed the console hook (activation/routes.ts). */
function adminIdOf(request: FastifyRequest): string {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) throw notFound();
  return account.id;
}

/** A campaign body whose window ends after it starts (the table's CHECK, answered with the field). */
function campaignOf(body: unknown): CampaignBody {
  const campaign = parse(campaignBodySchema, body);
  if (Date.parse(campaign.endsAt) <= Date.parse(campaign.startsAt)) {
    throw invalidQuestify({ field: "endsAt" });
  }
  return campaign;
}

/**
 * "Set your interests" is met or not and has no date (ADR-320): its target is 1 and it is never in a campaign. The
 * table's CHECK, answered with the field.
 */
function questOf<T extends QuestPatch>(schema: z.ZodType<T>, body: unknown): T {
  const quest = parse(schema, body);
  if (quest.metric !== INTERESTS_METRIC) return quest;
  if (quest.target !== 1) throw invalidQuestify({ field: "target" });
  if ("campaignId" in quest && quest.campaignId !== null)
    throw invalidQuestify({ field: "metric" });
  return quest;
}

/**
 * The console's Questify quests page (T-403b, FR-710, FR-711): registered inside the console scope, whose hook answers
 * 404 to anyone but an active platform admin and sets `no-store`. Every write takes an Idempotency-Key; the database
 * checks the admin again and audits each write.
 */
export function registerConsoleQuestifyRoutes(
  scope: FastifyInstance,
  deps: Readonly<{ pool: Pool }>,
): void {
  scope.get("/questify", read, async (request) => listQuestify(deps.pool, adminIdOf(request)));
  // The ranking's seasons (T-408, FR-1786, ADR-323): read only; a season turns over by itself, with no reset.
  scope.get("/questify/seasons", read, async (request) =>
    listSeasons(deps.pool, adminIdOf(request)),
  );
  scope.get("/questify/seasons/:month", read, async (request) => {
    const { month } = parse(seasonParams, request.params);
    return readSeason(deps.pool, adminIdOf(request), month);
  });

  scope.post("/questify/campaigns", write, async (request, reply) => {
    const body = campaignOf(request.body);
    const campaign = await saveCampaign(deps.pool, adminIdOf(request), {
      id: null,
      body,
      requestId: request.id,
    });
    return reply.code(201).send({ campaign });
  });

  scope.put("/questify/campaigns/:campaignId", write, async (request) => {
    const { campaignId } = parse(campaignParams, request.params);
    const body = campaignOf(request.body);
    return {
      campaign: await saveCampaign(deps.pool, adminIdOf(request), {
        id: campaignId,
        body,
        requestId: request.id,
      }),
    };
  });

  scope.post("/questify/campaigns/:campaignId/publish", write, async (request) => {
    const { campaignId } = parse(campaignParams, request.params);
    const act = { id: campaignId, requestId: request.id };
    return { campaign: await publishCampaign(deps.pool, adminIdOf(request), act) };
  });

  scope.post("/questify/campaigns/:campaignId/retire", write, async (request) => {
    const { campaignId } = parse(campaignParams, request.params);
    const act = { id: campaignId, requestId: request.id };
    return { campaign: await retireCampaign(deps.pool, adminIdOf(request), act) };
  });

  scope.post("/questify/quests", write, async (request, reply) => {
    const body = questOf(questBodySchema, request.body);
    const quest = await saveQuest(deps.pool, adminIdOf(request), {
      id: null,
      body,
      requestId: request.id,
    });
    return reply.code(201).send({ quest });
  });

  scope.put("/questify/quests/:questId", write, async (request) => {
    const { questId } = parse(questParams, request.params);
    const body = questOf(questPatchSchema, request.body);
    return {
      quest: await saveQuest(deps.pool, adminIdOf(request), {
        id: questId,
        body,
        requestId: request.id,
      }),
    };
  });

  scope.post("/questify/quests/:questId/retire", write, async (request) => {
    const { questId } = parse(questParams, request.params);
    const act = { id: questId, requestId: request.id };
    return { quest: await retireQuest(deps.pool, adminIdOf(request), act) };
  });
}
