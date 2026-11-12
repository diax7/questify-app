// A player plays the demo the way the app does (local tests only: on staging a code goes to a real mailbox): sign in
// by email code, join by the event's code, scan a QR quest, type the entry code, stamp the passport and redeem the
// coffee voucher. Answers what passed and the balance left.
import { acceptance } from "./auth.mjs";
import { ENTRY_CODES } from "./content.mjs";

const tokenOf = (url) => url.slice(url.indexOf("/q/") + 3);

/** Email code, profile and join; answers the player's access token. */
async function signUpAndJoin(api, { email, joinCode, readCode }) {
  const accept = await acceptance(api, "player");
  const asked = await api.call("POST", "/v1/auth/code", {
    body: { channel: "email", value: email, accept },
    expect: [202],
  });
  const verified = await api.call("POST", "/v1/auth/verify", {
    body: { challengeToken: asked.body.challengeToken, code: readCode(email) },
  });
  const created = await api.call("POST", "/v1/auth/signup", {
    body: {
      signupToken: verified.body.signupToken,
      username: "demo_player",
      birthYear: 1995,
      avatar: "falcon",
    },
  });
  const token = created.body.accessToken;
  const card = (await api.call("GET", `/v1/public/events/${joinCode}`)).body.card;
  await api.call("POST", "/v1/join", {
    token,
    body: { joinCode, via: "code", cardVersion: card.version },
  });
  return token;
}

async function questIds(api, token, eventId) {
  const { body } = await api.call("GET", `/v1/events/${eventId}/quests`, {
    token,
  });
  const quests = body.quests ?? (body.categories ?? []).flatMap((c) => c.quests ?? []);
  return new Map(quests.map((q) => [q.title?.en, q.id]));
}

export async function playerSmoke(api, { email, joinCode, eventId, codes, readCode }) {
  const token = await signUpAndJoin(api, { email, joinCode, readCode });
  const done = [];
  const own = codes.codes.filter((c) => c.stepId === null);
  const welcome = own.find((c) => c.title.en === "Welcome desk");
  await api.call("POST", `/v1/quests/${welcome.questId}/complete`, {
    token,
    body: { proof: { type: "qr", code: tokenOf(welcome.url) } },
  });
  done.push("scan");
  const ids = await questIds(api, token, eventId);
  await api.call("POST", `/v1/quests/${ids.get("Secret word")}/complete`, {
    token,
    body: {
      proof: { type: "code", code: ENTRY_CODES.secretWord.toLowerCase() },
    },
  });
  done.push("entry code");
  for (const step of codes.codes.filter((c) => c.stepId !== null).slice(0, 3)) {
    await api.call("POST", `/v1/steps/${step.stepId}/stamp`, {
      token,
      body: { code: tokenOf(step.url) },
    });
  }
  done.push("passport");
  const shop = (await api.call("GET", `/v1/events/${eventId}/shop`, { token })).body;
  const coffee = (shop.rewards ?? shop.items ?? []).find((r) => r.name?.en === "Coffee voucher");
  await api.call("POST", `/v1/rewards/${coffee.id}/reserve`, {
    token,
    body: {},
  });
  done.push("redeem");
  const home = (await api.call("GET", `/v1/events/${eventId}/home`, { token })).body;
  return { done, balance: home.standing?.balance ?? 0 };
}
