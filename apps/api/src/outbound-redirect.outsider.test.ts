import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBreachCheck, BreachCheckUnavailable } from "#src/auth/breached";
import { createGmailSender } from "#src/auth/email/gmail";
import { createResendSender } from "#src/auth/email/resend";
import { createGoogleTokenSource, GoogleTokenError } from "#src/auth/google-token";
import { createMsegatSender } from "#src/players/sms";

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/**
 * The attacker's seat for ADR-701: a hostile or hijacked provider answers `302` to somewhere else. Each outside client,
 * with Node's real fetch and its own request init, must fail on its existing failure path, and the second server must
 * see nothing: no secret, body or bearer follows the redirect.
 */
describe("a provider that answers with a redirect", () => {
  let target: Server;
  let bouncer: Server;
  let targetUrl = "";
  let bouncerUrl = "";
  let reachedTarget = 0;

  /** Node's fetch, sent to the redirecting server whatever address the client asked for, with the client's own init. */
  const viaBouncer: typeof fetch = (_input, init) => fetch(bouncerUrl, init);

  beforeAll(async () => {
    target = createServer((_request, response) => {
      reachedTarget += 1;
      response.writeHead(200, { "content-type": "application/json" }).end('{"code":"1"}');
    });
    targetUrl = await listen(target);
    bouncer = createServer((_request, response) => {
      response.writeHead(302, { location: `${targetUrl}/stolen` }).end();
    });
    bouncerUrl = await listen(bouncer);
  });
  afterAll(async () => {
    await Promise.all(
      [target, bouncer].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });
  beforeEach(() => {
    reachedTarget = 0;
  });

  const key = () => ({
    clientEmail: "m@p.iam.gserviceaccount.com",
    privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    tokenUri: bouncerUrl,
  });

  it("the SMS gateway: the code is not sent there, and the send is not counted as sent", async () => {
    const sms = createMsegatSender({
      userName: "u",
      apiKey: "secret-key",
      sender: "Questify",
      fetch: viaBouncer,
    });
    const result = await sms.send({ to: "+966500000000", text: "1234" });
    expect(result.kind).not.toBe("sent");
    expect(reachedTarget).toBe(0);
  });

  it("Google's token endpoint: unreachable, and the signed assertion goes nowhere else", async () => {
    const source = createGoogleTokenSource({
      key: key(),
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      timeoutMs: 2_000,
      renewMarginSeconds: 60,
    });
    const failure = await source.get().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GoogleTokenError);
    expect((failure as GoogleTokenError).failure).toBe("unreachable");
    expect(reachedTarget).toBe(0);
  });

  it("the breach check: fails closed", async () => {
    await expect(createBreachCheck({ fetch: viaBouncer })("correct horse")).rejects.toBeInstanceOf(
      BreachCheckUnavailable,
    );
    expect(reachedTarget).toBe(0);
  });

  it("Resend and Gmail: the send fails", async () => {
    const message = { to: "a@b.sa", subject: "s", text: "1234" };
    await expect(
      createResendSender({ apiKey: "re_secret", from: "q@q.sa", fetch: viaBouncer }).send(message),
    ).rejects.toThrow();
    await expect(
      createGmailSender({ key: key(), from: "q@q.sa", fetch: viaBouncer }).send(message),
    ).rejects.toThrow();
    expect(reachedTarget).toBe(0);
  });
});
