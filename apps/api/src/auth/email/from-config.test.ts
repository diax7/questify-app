import { describe, expect, it, vi } from "vitest";
import { createEmailSender } from "#src/auth/email/from-config";
import type { EmailSender } from "#src/auth/email/sender";

const gmail = {
  key: {
    clientEmail: "mailer@questify.iam.gserviceaccount.test",
    privateKey: "unusable",
    tokenUri: "https://oauth2.googleapis.test/token",
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

  it("passes the mailbox to act for on to Gmail", () => {
    const sender = createEmailSender({
      gmail: { ...gmail, actAs: "owner@nafes.test" },
      resend: undefined,
    });
    expect(sender.name).toBe("failover");
  });
});
