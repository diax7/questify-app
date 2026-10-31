import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchMe } from "#src/lib/staff-api.ts";
import { startUpstream, type Upstream } from "#src/lib/upstream.test-support.ts";

const ME = {
  id: "u1",
  email: "owner@najd.sa",
  platformRole: "none",
  memberships: [
    { organizerId: "o1", organizerName: "Najd Events", role: "owner", eventScope: null },
  ],
};

describe("fetchMe", () => {
  let api: Upstream;
  const ask = (sessionToken: string | undefined = "token", forwardedFor: string | null = null) =>
    fetchMe({ apiOrigin: api.origin, sessionToken, forwardedFor, timeoutMs: 1_000 });
  const reply = (status: number, body: unknown) =>
    api.answer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });

  beforeAll(async () => {
    api = await startUpstream();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(() => {
    api.seen.length = 0;
  });

  it("does not call the API when there is no session cookie", async () => {
    const none = await fetchMe({
      apiOrigin: api.origin,
      sessionToken: undefined,
      forwardedFor: null,
    });
    expect(none).toEqual({ kind: "signed_out", ended: false });
    expect(await ask("")).toEqual({ kind: "signed_out", ended: false });
    expect(api.seen).toEqual([]);
  });

  it("sends only the session cookie and the client's chain", async () => {
    reply(200, ME);
    await ask("tok", "203.0.113.9");
    expect(api.seen[0]?.url).toBe("/v1/staff/me");
    expect(api.seen[0]?.headers).toMatchObject({
      cookie: "__Host-qs_session=tok",
      "x-forwarded-for": "203.0.113.9",
    });
  });

  it("returns the person and their organizers", async () => {
    reply(200, ME);
    expect(await ask()).toEqual({
      kind: "signed_in",
      me: {
        id: "u1",
        email: "owner@najd.sa",
        isAdmin: false,
        memberships: [
          { organizerId: "o1", organizerName: "Najd Events", role: "owner", eventScope: null },
        ],
      },
    });
  });

  it("carries the events an editor is limited to", async () => {
    const limited = { ...ME.memberships[0], role: "editor", eventScope: ["e1", "e2"] };
    reply(200, { ...ME, memberships: [limited] });
    expect(await ask()).toMatchObject({
      kind: "signed_in",
      me: { memberships: [{ role: "editor", eventScope: ["e1", "e2"] }] },
    });
  });

  it("says whether the person is a Questify admin", async () => {
    reply(200, { ...ME, platformRole: "admin" });
    expect(await ask()).toMatchObject({ kind: "signed_in", me: { isAdmin: true } });
    reply(200, { ...ME, platformRole: "superuser" });
    expect(await ask()).toMatchObject({ kind: "signed_in", me: { isAdmin: false } });
  });

  it("says whether a 401 means the session ran out", async () => {
    reply(401, { code: "session_expired" });
    expect(await ask()).toEqual({ kind: "signed_out", ended: true });
    reply(401, { code: "unauthenticated" });
    expect(await ask()).toEqual({ kind: "signed_out", ended: false });
  });

  it("treats a server error, a changed answer or no answer as unavailable", async () => {
    reply(500, {});
    expect(await ask()).toEqual({ kind: "unavailable" });
    reply(200, { ...ME, memberships: [{ organizerId: "o1", role: "admin" }] });
    expect(await ask()).toEqual({ kind: "unavailable" });
    reply(200, {
      ...ME,
      memberships: [{ organizerId: "o1", organizerName: "Najd Events", role: "owner" }],
    });
    expect(await ask()).toEqual({ kind: "unavailable" });
    reply(200, { id: "u1" });
    expect(await ask()).toEqual({ kind: "unavailable" });
    api.answer(() => undefined);
    expect(await ask()).toEqual({ kind: "unavailable" });
  });
});
