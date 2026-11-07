// Loaded before the spawned staff CLI for its success path in `staff-admin.int.test.ts`. The stdin guard and the closed
// network of the other preload hold, but for Google's two answers standing in for the provider: a token, and an accepted
// send. Any other address still fails.
await import("./staff-cli-preload.mjs");

const closedNetwork = globalThis.fetch;
const TOKEN_URL = "https://oauth2.googleapis.test/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

globalThis.fetch = (url, init) => {
  if (String(url) === TOKEN_URL) {
    return Promise.resolve(Response.json({ access_token: "a-token", expires_in: 3600 }));
  }
  if (String(url) === SEND_URL) {
    return Promise.resolve(Response.json({ id: "a-message" }));
  }
  return closedNetwork(url, init);
};
