// The whole build, in order. Answers what a person needs to play it: the join code and every printed code.
import { ENTRY_CODES } from "./content.mjs";
import {
  activateAsAdmin,
  ensureDailyWords,
  ensureHomeBlocks,
  ensureMap,
  ensureSessions,
  ensureSponsors,
  requestActivation,
} from "./extras.mjs";
import {
  ensureCategories,
  ensureCommunityGoal,
  ensureEvent,
  ensureOrganizer,
  ensureQuests,
  ensureRankPrizes,
  ensureRewards,
} from "./seed.mjs";

function scopeOf(api, cookie, organizerId) {
  const org = `/v1/organizers/${organizerId}`;
  return {
    api,
    base: "",
    log: [],
    call: (method, path, options = {}) => api.call(method, `${org}${path}`, { cookie, ...options }),
  };
}

/** The log lines of steps that did not run (the build went on without them): a person must look at each. */
export const skippedOf = (log) => log.filter((line) => line.startsWith("SKIPPED"));

/** One step that may be refused (a feature the platform keeps off): noted, and the build goes on. */
async function tolerant(log, label, work) {
  try {
    await work();
  } catch (error) {
    log.push(`SKIPPED ${label}: ${error.message}`);
  }
}

async function buildContent(s, event, now) {
  const categories = await ensureCategories(s);
  const quests = await ensureQuests(s, categories);
  const rewards = await ensureRewards(s);
  await tolerant(s.log, "rank prizes", () => ensureRankPrizes(s));
  await tolerant(s.log, "community goal", () => ensureCommunityGoal(s, event, now + 3 * 60_000));
  await tolerant(s.log, "map", () => ensureMap(s, quests));
  await tolerant(s.log, "sponsors", () => ensureSponsors(s, quests, rewards));
  await tolerant(s.log, "agenda", () => ensureSessions(s, now, now + 2 * 60_000));
  const ends = new Date(now + 30 * 86_400_000).toISOString();
  await tolerant(s.log, "home blocks", () => ensureHomeBlocks(s, rewards, ends));
  return { quests, rewards };
}

async function adminPart(api, adminCookie, eventId, now, log, dailyWord) {
  if (adminCookie === undefined) {
    log.push("no admin session: activate the event in the console (Events waiting for activation)");
    return;
  }
  await activateAsAdmin(api, adminCookie, eventId, log);
  await tolerant(log, "daily words", () =>
    ensureDailyWords(api, adminCookie, now, log, { changeCadence: dailyWord }),
  );
}

/**
 * Builds (or completes) the full demo. `accept` is the organizer documents in force, used only when the demo organizer
 * has to be made. Answers the organizer, the event, its printed codes and what was done.
 */
export async function buildDemo({
  api,
  ownerCookie,
  adminCookie,
  accept,
  reset = false,
  dailyWord = false,
  now = Date.now(),
}) {
  const organizerId = await ensureOrganizer(api, ownerCookie, accept);
  const s = scopeOf(api, ownerCookie, organizerId);
  const event = await ensureEvent(s, { reset, now });
  s.base = `/events/${event.id}`;
  await buildContent(s, event, now);
  await tolerant(s.log, "activation request", () => requestActivation(s));
  await adminPart(api, adminCookie, event.id, now, s.log, dailyWord);
  const codes = (await s.call("GET", `${s.base}/codes`)).body;
  return {
    organizerId,
    eventId: event.id,
    joinCode: event.joinCode,
    eventName: event.name,
    codes,
    entryCodes: ENTRY_CODES,
    log: s.log,
  };
}
