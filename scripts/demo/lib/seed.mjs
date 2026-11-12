// Builds the full demo event through the dashboard's own routes, as the organizer's owner would by hand. Every step
// looks first and adds only what is missing, so running it again changes nothing; `reset` ends the old demo event and
// builds a new one (a new join code). The optional admin session does what only Questify can: activate the event (with
// the big screen add-on) and fill the daily word for the coming days.
import {
  CATEGORIES,
  COMMUNITY_GOAL,
  EVENT_DETAILS,
  EVENT_NAME,
  ORGANIZER_NAME,
  QUESTS,
  RANK_PRIZES,
  RANK_RULES,
  REWARDS,
  SHOP,
} from "./content.mjs";

const DAY_MS = 86_400_000;
const RIYADH_OFFSET_MS = 3 * 3_600_000;
const EVENT_DAYS = 30;

/** A wall-clock time in Riyadh (no daylight saving), as the event fields take it: `YYYY-MM-DDTHH:mm`. */
export const riyadhLocal = (ms) => new Date(ms + RIYADH_OFFSET_MS).toISOString().slice(0, 16);

const sameEn = (a, b) => (a?.en ?? a?.nameEn ?? "").trim() === b.trim();

/** The demo organizer the owner holds, made when missing. */
export async function ensureOrganizer(api, cookie, accept) {
  const me = (await api.call("GET", "/v1/staff/me", { cookie })).body;
  const held = me.memberships.find((m) => m.role === "owner" && m.organizerName === ORGANIZER_NAME);
  if (held !== undefined) {
    return held.organizerId;
  }
  const made = await api.call("POST", "/v1/staff/organizers", {
    cookie,
    body: { name: ORGANIZER_NAME, accept },
  });
  return made.body.organizerId;
}

const isOpen = (event) => !["ended", "archived"].includes(event.status);

const refused = (error) => error.status === 409 || error.status === 422;

/** Removes a draft demo event that was never launched (the end route refuses a draft: 409 `event_not_live`). */
async function removeDraft(s, event, refusal) {
  try {
    await s.call("DELETE", `/events/${event.id}`, { expect: [204] });
  } catch (error) {
    if (refused(error)) {
      throw stopped(event, error);
    }
    throw error;
  }
  s.log.push(`removed the unlaunched old demo event ${event.joinCode} (end answered ${refusal})`);
}

const stopped = (event, error) =>
  new Error(
    `--reset stopped: the old demo event ${event.joinCode} could not be ended or removed (${error.message}). Nothing new was built.`,
  );

/** Ends one open demo event, logging the real status. A refusal (409, 422) stops the reset, since the old event would
 * stay open beside the new one; only a draft, which cannot be ended, is removed instead. */
async function endEvent(s, event) {
  let answer;
  try {
    answer = await s.call("POST", `/events/${event.id}/end`, {
      body: { confirm: true },
      expect: [200, 201, 204],
    });
  } catch (error) {
    if (!refused(error)) {
      throw error;
    }
    if (event.status === "draft") {
      return removeDraft(s, event, error.status);
    }
    throw stopped(event, error);
  }
  s.log.push(`ended the old demo event ${event.joinCode} (answered ${answer.status})`);
}

/** The open demo event, or a new one; with `reset`, open ones are ended first. */
export async function ensureEvent(s, { reset, now }) {
  const listed = (await s.call("GET", "/events")).body.events ?? [];
  const mine = listed.filter((event) => sameEn(event.name, EVENT_NAME.en) && isOpen(event));
  if (!reset && mine[0] !== undefined) {
    return mine[0];
  }
  for (const event of mine) {
    await endEvent(s, event);
  }
  const body = {
    ...EVENT_DETAILS,
    name: EVENT_NAME,
    startsAt: riyadhLocal(now + 2 * 60_000),
    endsAt: riyadhLocal(now + EVENT_DAYS * DAY_MS),
  };
  const made = (await s.call("POST", "/events", { body })).body.event;
  s.log.push(`made the demo event ${made.joinCode}`);
  return made;
}

/** The quest builder: the categories, and every quest flattened beside them. */
async function builder(s) {
  const { categories } = (await s.call("GET", `${s.base}/quests`)).body;
  return {
    categories,
    quests: categories.flatMap((category) => category.quests ?? []),
  };
}

/** The demo categories by key: the event's first (default) category is renamed to the first one. */
export async function ensureCategories(s) {
  const found = {};
  let { categories } = await builder(s);
  const first = categories[0];
  if (first !== undefined && !categories.some((c) => sameEn(c.name, CATEGORIES[0].name.en))) {
    await s.call("PATCH", `${s.base}/categories/${first.id}`, {
      body: { name: CATEGORIES[0].name },
    });
    ({ categories } = await builder(s));
  }
  for (const wanted of CATEGORIES) {
    let category = categories.find((c) => sameEn(c.name, wanted.name.en));
    if (category === undefined) {
      category = (
        await s.call("POST", `${s.base}/categories`, {
          body: { name: wanted.name },
        })
      ).body.category;
      s.log.push(`category ${wanted.name.en}`);
    }
    if (wanted.hidden === true && category.hidden !== true) {
      await s.call("PATCH", `${s.base}/categories/${category.id}`, {
        body: { hidden: true },
      });
    }
    found[wanted.key] = category.id;
  }
  return found;
}

const questBodyOf = (categoryId, quest) => {
  const { mapPin: _pin, ...body } = quest;
  return { categoryId, ...body };
};

/** Every demo quest, made when missing; answers them by English title. */
export async function ensureQuests(s, categoryIds) {
  const existing = (await builder(s)).quests ?? [];
  const byTitle = new Map(existing.map((q) => [q.title?.en, q]));
  for (const [key, quests] of Object.entries(QUESTS)) {
    for (const quest of quests) {
      if (byTitle.has(quest.title.en)) {
        continue;
      }
      const made = await s.call("POST", `${s.base}/quests`, {
        body: questBodyOf(categoryIds[key], quest),
      });
      byTitle.set(quest.title.en, made.body.quest);
      s.log.push(`quest ${quest.type}: ${quest.title.en}`);
    }
  }
  return byTitle;
}

const textOf = (value) => `${value?.en ?? ""}|${value?.ar ?? ""}`;

/** True when the shop is already as the demo wants it (pickup time, rules and the prize desk's place). */
const shopMatches = (shop) =>
  shop?.pickupMinutes === SHOP.pickupMinutes &&
  textOf(shop.rules) === textOf(SHOP.rules) &&
  textOf(shop.desk?.location) === textOf(SHOP.desk.location);

/** Adds a digital reward's codes when fewer are loaded than the demo has (the API skips a code it already holds, so
 * a rerun after a half-built reward tops it up). Answers how many were added. */
async function topUpCodes(s, reward, codes) {
  if ((reward.stock ?? 0) >= codes.length) {
    return 0;
  }
  const added = await s.call("POST", `${s.base}/rewards/${reward.id}/codes`, { body: { codes } });
  return added.body.added ?? 0;
}

/** The shop rewards, a digital one with its reward codes; answers them by English name. The shop's prize desk comes
 * first: an item or an experience needs one. The shop is written only when it differs from the demo's, and a reward
 * found with fewer codes than the demo has gets the rest. */
export async function ensureRewards(s) {
  const listed = (await s.call("GET", `${s.base}/rewards`)).body;
  if (!shopMatches(listed.shop)) {
    await s.call("PUT", `${s.base}/shop`, { body: SHOP });
    s.log.push("shop settings");
  }
  const byName = new Map((listed.rewards ?? []).map((r) => [r.name?.en, r]));
  for (const { codes, ...reward } of REWARDS) {
    const found = byName.get(reward.name.en);
    if (found !== undefined) {
      const added = codes === undefined ? 0 : await topUpCodes(s, found, codes);
      if (added > 0) {
        s.log.push(`reward ${reward.name.en}: topped up ${added} codes`);
      }
      continue;
    }
    const made = (await s.call("POST", `${s.base}/rewards`, { body: reward })).body.reward;
    byName.set(reward.name.en, made);
    if (codes !== undefined) {
      await topUpCodes(s, made, codes);
    }
    s.log.push(
      `reward ${reward.kind}: ${reward.name.en}${codes ? ` with ${codes.length} codes` : ""}`,
    );
  }
  return byName;
}

/** The rank prizes switched on with their rules, and the two prizes. */
export async function ensureRankPrizes(s) {
  const current = (await s.call("GET", `${s.base}/rank-prizes`)).body;
  if (current.settings?.rankPrizes !== true && current.rankPrizes !== true) {
    await s.call("PUT", `${s.base}/rank-prizes`, {
      body: { rankPrizes: true, rules: RANK_RULES },
    });
  }
  const prizes = current.prizes ?? [];
  for (const prize of RANK_PRIZES) {
    if (!prizes.some((p) => sameEn(p.name, prize.name.en))) {
      await s.call("POST", `${s.base}/rank-prizes`, { body: prize });
      s.log.push(`rank prize ${prize.rankFrom}-${prize.rankTo}: ${prize.name.en}`);
    }
  }
}

/** The community goal, from now to the event's end. */
export async function ensureCommunityGoal(s, event, now) {
  const goals = (await s.call("GET", `${s.base}/community-goals`)).body.goals ?? [];
  if (goals.some((g) => sameEn(g.title, COMMUNITY_GOAL.title.en))) {
    return;
  }
  const endsAt = new Date(Date.parse(`${event.endsAt.slice(0, 16)}:00Z`) - RIYADH_OFFSET_MS);
  const body = {
    ...COMMUNITY_GOAL,
    startsAt: new Date(now).toISOString(),
    endsAt: (Number.isNaN(endsAt.getTime())
      ? new Date(now + EVENT_DAYS * DAY_MS)
      : endsAt
    ).toISOString(),
  };
  await s.call("POST", `${s.base}/community-goals`, { body });
  s.log.push(`community goal: ${COMMUNITY_GOAL.title.en}`);
}
