import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFailoverSender } from "#src/auth/email/failover";
import { createEmailSender } from "#src/auth/email/from-config";
import { createGmailSender } from "#src/auth/email/gmail";
import type { EmailSender } from "#src/auth/email/sender";
import type { ServiceAccountKey } from "#src/auth/google-token";

/** The real builders, watched: the options they are handed are what these tests read. */
vi.mock("#src/auth/email/gmail", async (original) => {
  const real = await original<typeof import("#src/auth/email/gmail")>();
  return { ...real, createGmailSender: vi.fn(real.createGmailSender) };
});
vi.mock("#src/auth/email/failover", async (original) => {
  const real = await original<typeof import("#src/auth/email/failover")>();
  return { ...real, createFailoverSender: vi.fn(real.createFailoverSender) };
});

const TOKEN_URI = "https://oauth2.googleapis.test/token";
const SEND_URI = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const RESEND_URI = "https://api.resend.com/emails";

const gmail = {
  key: {
    clientEmail: "mailer@questify.iam.gserviceaccount.test",
    privateKey: "unusable",
    tokenUri: TOKEN_URI,
  },
  from: "questify@nafes.test",
  actAs: undefined,
};
const message = { to: "a@najd.test", subject: "s", text: "t" };

/** Wraps nothing: names each provider and replaces it, so no test reaches a real one. */
function fakes(failing: readonly string[]) {
  const named: string[] = [];
  const called: string[] = [];
  const wrap = (_sender: EmailSender, provider: string): EmailSender => {
    named.push(provider);
    return {
      name: provider,
      send: async () => {
        called.push(provider);
        if (failing.includes(provider)) throw new Error(`${provider} is down`);
      },
    };
  };
  return { named, called, wrap };
}

describe("createEmailSender", () => {
  it("has Gmail alone without Resend, so one Gmail failure is final", async () => {
    const { named, wrap } = fakes(["gmail"]);
    const sender = createEmailSender({ gmail, resend: undefined }, { wrap });
    expect(named).toEqual(["gmail"]);
    await expect(sender.send(message)).rejects.toThrow("gmail is down");
  });

  it("falls over to Resend when it is configured, and says so by name", async () => {
    const { named, called, wrap } = fakes(["gmail"]);
    const onFailover = vi.fn();
    const sender = createEmailSender(
      { gmail, resend: { apiKey: "re_key", from: "a@nafes.test" } },
      { wrap, onFailover },
    );
    expect(named).toEqual(["gmail", "resend"]);
    await sender.send(message);
    expect(called).toEqual(["gmail", "resend"]);
    expect(onFailover).toHaveBeenCalledWith("gmail", "resend");
  });

  it("works with no options, as the CLI calls it", () => {
    expect(createEmailSender({ gmail, resend: undefined }).name).toBe("failover");
  });

  describe("through the network", () => {
    type Call = Readonly<{ url: string; init: RequestInit }>;
    let key: ServiceAccountKey;
    let calls: Call[];
    let gmailStatus: number;

    beforeAll(() => {
      const pair = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      key = { ...gmail.key, privateKey: pair.privateKey };
    });

    beforeEach(() => {
      calls = [];
      gmailStatus = 200;
      // The network is the boundary: Google's two endpoints and Resend's, answering and recording.
      vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url) === TOKEN_URI) {
          return Response.json({ access_token: "tok-1", expires_in: 3600 });
        }
        if (String(url) === SEND_URI) return Response.json({ id: "m1" }, { status: gmailStatus });
        return Response.json({ id: "r1" });
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const callsTo = (url: string) => calls.filter((call) => call.url === url);
    /** The mailbox the service account signed in as: the `sub` claim of the token request. */
    const signedInAs = (): unknown => {
      const form = new URLSearchParams(String(callsTo(TOKEN_URI)[0]?.init.body));
      const claims = (form.get("assertion") ?? "").split(".")[1] ?? "";
      return (JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { sub?: unknown })
        .sub;
    };
    /** The MIME message Gmail was asked to send. */
    const sentMime = (): string => {
      const body = JSON.parse(String(callsTo(SEND_URI)[0]?.init.body)) as { raw: string };
      return Buffer.from(body.raw, "base64url").toString("utf8");
    };

    it("sends through Gmail with no options and no Resend", async () => {
      await createEmailSender({ gmail: { ...gmail, key }, resend: undefined }).send(message);
      expect(callsTo(SEND_URI)).toHaveLength(1);
      expect(callsTo(RESEND_URI)).toHaveLength(0);
      expect(sentMime()).toContain("From: Questify <questify@nafes.test>");
      expect(callsTo(SEND_URI)[0]?.init.headers).toMatchObject({ authorization: "Bearer tok-1" });
    });

    it("reports a Gmail failure with no backup and no failover callback, rather than crashing", async () => {
      gmailStatus = 500;
      const sender = createEmailSender({ gmail: { ...gmail, key }, resend: undefined });
      await expect(sender.send(message)).rejects.toMatchObject({
        name: "EmailSendError",
        sender: "gmail",
        message: expect.stringContaining("500") as string,
      });
      expect(callsTo(RESEND_URI)).toHaveLength(0);
    });

    it("signs in as the sender address when no mailbox to act for is set", async () => {
      await createEmailSender({ gmail: { ...gmail, key }, resend: undefined }).send(message);
      expect(signedInAs()).toBe("questify@nafes.test");
    });

    it("signs in as the mailbox to act for, and still sends from the sender address", async () => {
      await createEmailSender({
        gmail: { ...gmail, key, actAs: "owner@nafes.test" },
        resend: undefined,
      }).send(message);
      expect(signedInAs()).toBe("owner@nafes.test");
      expect(sentMime()).toContain("From: Questify <questify@nafes.test>");
    });

    it("falls over to Resend on a Gmail failure, and says so", async () => {
      gmailStatus = 500;
      const onFailover = vi.fn();
      await createEmailSender(
        { gmail: { ...gmail, key }, resend: { apiKey: "re_key", from: "a@nafes.test" } },
        { onFailover },
      ).send(message);
      expect(callsTo(RESEND_URI)).toHaveLength(1);
      expect(onFailover).toHaveBeenCalledWith("gmail", "resend");
    });
  });

  describe("the options it hands on", () => {
    it("gives Gmail the key and the sender address, and no mailbox to act for when none is set", () => {
      createEmailSender({ gmail, resend: undefined });
      expect(vi.mocked(createGmailSender)).toHaveBeenLastCalledWith(
        expect.objectContaining({ key: gmail.key, from: gmail.from }),
      );
      // Strictly: an absent key, not `actAs: undefined` (exactOptionalPropertyTypes forbids the second).
      const options = vi.mocked(createGmailSender).mock.lastCall?.[0];
      expect(options).toStrictEqual({ key: gmail.key, from: gmail.from });
    });

    it("gives Gmail the mailbox to act for when one is set", () => {
      createEmailSender({ gmail: { ...gmail, actAs: "owner@nafes.test" }, resend: undefined });
      expect(vi.mocked(createGmailSender).mock.lastCall?.[0]).toStrictEqual({
        key: gmail.key,
        from: gmail.from,
        actAs: "owner@nafes.test",
      });
    });

    it("gives the failover only the primary when there is no Resend and no callback", () => {
      createEmailSender({ gmail, resend: undefined });
      expect(vi.mocked(createFailoverSender).mock.lastCall?.[0]).toStrictEqual({
        primary: expect.objectContaining({ name: "gmail" }) as EmailSender,
      });
    });

    it("gives the failover the backup and the callback when both exist", () => {
      const onFailover = vi.fn();
      createEmailSender(
        { gmail, resend: { apiKey: "re_key", from: "a@nafes.test" } },
        { onFailover },
      );
      expect(vi.mocked(createFailoverSender).mock.lastCall?.[0]).toStrictEqual({
        primary: expect.objectContaining({ name: "gmail" }) as EmailSender,
        backup: expect.objectContaining({ name: "resend" }) as EmailSender,
        onFailover,
      });
    });
  });
});
