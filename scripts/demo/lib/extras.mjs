// The rest of the demo event: map, sponsors, agenda, Home blocks, the activation request, and the Questify admin's
// part (activation and the daily word). Each step is idempotent, as in seed.mjs.
import { DAILY_WORDS, MAP, SESSIONS, SPONSORS, homeContent } from "./content.mjs";

const DAY_MS = 86_400_000;
const sameEn = (value, en) => (value ?? "").trim() === en;

/** True when a pin is already on the map: the same quest, amenity, or kind and English name. */
const hasPin = (pins, wanted) =>
  pins.some((pin) => {
    if (pin.kind !== wanted.kind) {
      return false;
    }
    if (wanted.kind === "quest") {
      return pin.questId === wanted.questId;
    }
    return wanted.kind === "amenity"
      ? pin.amenity === wanted.amenity
      : pin.nameEn === wanted.nameEn;
  });

/** The hall map with its pins; the main stage quest gets a quest pin. A map found short of pins (a run that stopped
 * half way) gets the missing ones. */
export async function ensureMap(s, quests) {
  const maps = (await s.call("GET", `${s.base}/maps`)).body.maps ?? [];
  const { pins, ...name } = MAP;
  const stage = quests.get("Main stage");
  const wanted = [
    ...pins,
    ...(stage === undefined ? [] : [{ kind: "quest", questId: stage.id, x: 500, y: 200 }]),
  ];
  let map = maps.find((m) => sameEn(m.nameEn, MAP.nameEn));
  const made = map === undefined;
  if (made) {
    map = (await s.call("POST", `${s.base}/maps`, { body: name })).body;
  }
  let added = 0;
  for (const pin of wanted) {
    if (!hasPin(map.pins ?? [], pin)) {
      await s.call("POST", `${s.base}/maps/${map.id}/pins`, { body: pin });
      added += 1;
    }
  }
  if (made) {
    s.log.push(`map ${MAP.nameEn} with ${added} pins`);
  } else if (added > 0) {
    s.log.push(`map ${MAP.nameEn}: added ${added} missing pins`);
  }
}

/** The sponsors, each tagged on its quest or reward. A sponsor found without its tag (a run that stopped between the
 * two) gets the tag. A tag whose quest or reward is missing is an error, not a silent gap. */
export async function ensureSponsors(s, quests, rewards) {
  const sponsors = (await s.call("GET", `${s.base}/sponsors`)).body.sponsors ?? [];
  for (const { tag, ...sponsor } of SPONSORS) {
    let held = sponsors.find((x) => sameEn(x.nameEn, sponsor.nameEn));
    const made = held === undefined;
    if (made) {
      held = (await s.call("POST", `${s.base}/sponsors`, { body: sponsor })).body;
    }
    const target = (tag.kind === "reward" ? rewards : quests).get(tag.title);
    if (target === undefined) {
      throw new Error(
        `sponsor ${sponsor.nameEn}: the ${tag.kind} "${tag.title}" to tag is missing`,
      );
    }
    const tagged = (held.tags ?? []).some((t) => t.kind === tag.kind && t.targetId === target.id);
    if (!tagged) {
      await s.call("PUT", `${s.base}/sponsor-tags`, {
        body: { kind: tag.kind, targetId: target.id, sponsorId: held.id },
      });
    }
    if (made) {
      s.log.push(`sponsor ${sponsor.tier}: ${sponsor.nameEn}`);
    } else if (!tagged) {
      s.log.push(`sponsor ${sponsor.nameEn}: tagged on ${tag.title}`);
    }
  }
}

/** Two agenda talks (an hour each, Riyadh time, the first day they fit); skipped when the agenda already has them. */
export async function ensureSessions(s, now, eventStartMs) {
  const listed = (await s.call("GET", `${s.base}/sessions`)).body.sessions ?? [];
  const day = new Date(now + 3 * 3_600_000).toISOString().slice(0, 10);
  for (const session of SESSIONS) {
    if (listed.some((x) => sameEn(x.titleEn, session.title.en))) {
      continue;
    }
    const startsAt = new Date(`${day}T${String(session.startHour).padStart(2, "0")}:00:00+03:00`);
    // A talk before the event's start moves on a day at a time, so the agenda shows something to come.
    let start = startsAt.getTime();
    while (start < Math.max(now, eventStartMs)) {
      start += DAY_MS;
    }
    await s.call("POST", `${s.base}/sessions`, {
      body: {
        kind: "talk",
        titleEn: session.title.en,
        titleAr: session.title.ar,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 3_600_000).toISOString(),
        access: "open",
      },
    });
    s.log.push(`agenda talk: ${session.title.en}`);
  }
}

/** The Home blocks: the welcome banner, a link, a text card and a countdown to the event's end, featured coffee. */
export async function ensureHomeBlocks(s, rewards, endsAtIso) {
  const event = (await s.call("GET", s.base)).body.event;
  const layout = event.layout;
  if ((layout?.content?.cards ?? []).some((card) => card.id === "demotxt1")) {
    return;
  }
  const content = homeContent(endsAtIso);
  const coffee = rewards.get("Coffee voucher");
  const order = layout.home.order.filter((key) => !key.startsWith("card:"));
  const body = {
    bar: layout.bar,
    info: layout.info,
    looks: layout.looks,
    home: {
      order: [...order, "card:demotxt1", "card:democnt1"],
      hidden: layout.home.hidden,
    },
    content: {
      ...layout.content,
      ...content,
      ...(coffee === undefined ? {} : { featured: { kind: "reward", id: coffee.id } }),
    },
  };
  await s.call("PUT", `${s.base}/layout`, { body });
  s.log.push("home blocks: banner, link, text card, countdown, featured reward");
}

/** The owner asks Questify to activate the event (the console's queue); nothing when already asked or active. */
export async function requestActivation(s) {
  const answer = await s.call("POST", `${s.base}/activation`, {
    body: {},
    expect: [200, 201, 409],
  });
  s.log.push(answer.status === 409 ? "activation: already active" : "activation requested");
}

/** As a Questify admin: activates the event with the big screen add-on (T-210's console door). */
export async function activateAsAdmin(api, adminCookie, eventId, log) {
  const answer = await api.call("POST", `/v1/admin/events/${eventId}/activate`, {
    cookie: adminCookie,
    body: { limit: { mode: "none" }, addons: ["bigScreen"] },
    expect: [200, 409],
  });
  log.push(
    answer.status === 409 ? "activation: already active" : "activated by the admin, big screen on",
  );
}

const dayOf = (ms) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);

async function wordPeriods(api, adminCookie, now) {
  const range = `from=${dayOf(now)}&to=${dayOf(now + (DAILY_WORDS.en.length - 1) * DAY_MS)}`;
  const view = (await api.call("GET", `/v1/admin/daily?${range}`, { cookie: adminCookie })).body;
  const periods = (view.periods ?? []).filter((period) => period.kind === "word");
  const cadence = view.status?.word ?? {};
  return {
    periods,
    cadence: cadence.cadence ?? "unknown",
    daily: (cadence.next?.cadence ?? cadence.cadence) === "daily",
  };
}

const hasBoth = (period) => period?.words?.ar !== undefined && period?.words?.en !== undefined;

/**
 * As a Questify admin: the daily word in both languages for the next 6 days (tomorrow on: today's period has started
 * and cannot take a word, 409 `started`). Nothing changes when today's word is already there. The word's cadence is a
 * staging-wide setting, so it is changed only when `changeCadence` is true (the `--daily-word` flag): then, when it is
 * not daily, it turns daily from the next Questify day and the log says what it was (to revert, see PHONE_DEMO.md).
 * Without the flag a cadence that is not daily is left alone, and so are the words.
 */
export async function ensureDailyWords(api, adminCookie, now, log, { changeCadence = false } = {}) {
  const found = await wordPeriods(api, adminCookie, now);
  let { periods } = found;
  if (hasBoth(periods.find((period) => period.startsOn <= dayOf(now)))) {
    return;
  }
  if (!found.daily) {
    if (!changeCadence) {
      log.push(
        `daily word: cadence is ${found.cadence} and was left alone; run build --daily-word to turn it daily (staging-wide)`,
      );
      return;
    }
    await api.call("PUT", "/v1/admin/daily/cadence", {
      cookie: adminCookie,
      body: { kind: "word", cadence: "daily" },
    });
    log.push(`daily word cadence: daily from tomorrow (was ${found.cadence})`);
    ({ periods } = await wordPeriods(api, adminCookie, now));
  }
  let set = 0;
  for (const [language, words] of Object.entries(DAILY_WORDS)) {
    const open = periods.filter(
      (period) => period.startsOn > dayOf(now) && period.words?.[language] === undefined,
    );
    for (const [i, period] of open.slice(0, words.length).entries()) {
      await api.call("PUT", `/v1/admin/daily/words/${language}/${period.startsOn}`, {
        cookie: adminCookie,
        body: { word: words[i] },
      });
      set += 1;
    }
  }
  if (set > 0) {
    log.push(`daily words set: ${set}`);
  }
}
