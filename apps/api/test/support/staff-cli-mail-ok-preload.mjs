// Loaded before the spawned staff CLI for its success path in `staff-admin.int.test.ts`. The stdin guard and the closed
// network of the other preload hold, then Google's two answers stand in for the provider: a token, and an accepted send.
await import("./staff-cli-preload.mjs");

globalThis.fetch = (url) =>
  Promise.resolve(
    String(url).endsWith("/token")
      ? Response.json({ access_token: "a-token", expires_in: 3600 })
      : Response.json({ id: "a-message" }),
  );
