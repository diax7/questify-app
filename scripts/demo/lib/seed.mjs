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

async function endEvent(s, event) {
  await s.call("POST", `/events/${event.id}/end`, {
    body: { confirm: true },
    expect: [200, 201, 204, 409, 422],
  });
  s.log.push(`ended the old demo event ${event.joinCode}`);
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

/** The shop rewards, a digital one with its reward codes; answers them by English name. The shop's prize desk comes
 * first: an item or an experience needs one. */
export async function ensureRewards(s) {
  await s.call("PUT", `${s.base}/shop`, { body: SHOP });
  const existing = (await s.call("GET", `${s.base}/rewards`)).body.rewards ?? [];
  const byName = new Map(existing.map((r) => [r.name?.en, r]));
  for (const { codes, ...reward } of REWARDS) {
    if (byName.has(reward.name.en)) {
      continue;
    }
    const made = (await s.call("POST", `${s.base}/rewards`, { body: reward })).body.reward;
    byName.set(reward.name.en, made);
    if (codes !== undefined) {
      await s.call("POST", `${s.base}/rewards/${made.id}/codes`, {
        body: { codes },
      });
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
