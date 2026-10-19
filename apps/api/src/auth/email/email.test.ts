import { describe, expect, it, vi } from "vitest";
import { createFailoverSender } from "#src/auth/email/failover";
import { createResendSender } from "#src/auth/email/resend";
import { EmailSendError, type EmailSender } from "#src/auth/email/sender";
import { createSmtpSender, type SmtpTransport } from "#src/auth/email/smtp";
import { newSignInAlertEmail, signInCodeEmail } from "#src/auth/email/templates";

const message = { to: "sara@najd.sa", subject: "s", text: "t 123456" };

const okSender = (name: string): EmailSender & { sent: unknown[] } => {
  const sent: unknown[] = [];
  return {
    name,
    sent,
    send: async (m) => {
      sent.push(m);
    },
  };
};
const failingSender = (name: string): EmailSender => ({
  name,
  send: async () => {
    throw new EmailSendError(name, "down");
  },
});

describe("createSmtpSender", () => {
  it("sends from the signed-in account with the given subject and text", async () => {
    const sendMail = vi.fn<SmtpTransport["sendMail"]>(async () => ({}));
    await createSmtpSender({
      user: "bot@gmail.com",
      appPassword: "x",
      transport: { sendMail },
    }).send(message);
    expect(sendMail).toHaveBeenCalledWith({
      from: "Questify <bot@gmail.com>",
      to: "sara@najd.sa",
      subject: "s",
      text: "t 123456",
    });
  });

  it("turns any transport failure into an EmailSendError that hides the recipient and text", async () => {
    const sender = createSmtpSender({
      user: "bot@gmail.com",
      appPassword: "x",
      transport: {
        sendMail: async () => {
          throw new Error("550 sara@najd.sa rejected: t 123456");
        },
      },
    });
    const error = await sender.send(message).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(String((error as Error).message)).not.toContain("sara@najd.sa");
    expect(String((error as Error).message)).not.toContain("123456");
  });
});

describe("createResendSender", () => {
  const options = { apiKey: "re_key", from: "no-reply@questify.sa" };

  it("posts the message to the Resend API with the key and the verified From", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await createResendSender({ ...options, fetch: fakeFetch }).send(message);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect((call?.init.headers as Record<string, string> | undefined)?.["authorization"]).toBe(
      "Bearer re_key",
    );
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: "no-reply@questify.sa",
      to: ["sara@najd.sa"],
      subject: "s",
      text: "t 123456",
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails on a non-success answer, naming only the status", async () => {
    const fakeFetch = (async () => new Response("bad", { status: 422 })) as unknown as typeof fetch;
    await expect(
      createResendSender({ ...options, fetch: fakeFetch }).send(message),
    ).rejects.toThrow(/answered 422/);
  });

  it("fails when the network call fails or times out", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      createResendSender({ ...options, fetch: fakeFetch }).send(message),
    ).rejects.toBeInstanceOf(EmailSendError);
  });
});

describe("createFailoverSender", () => {
  it("uses only the primary when it works", async () => {
    const primary = okSender("smtp");
    const backup = okSender("resend");
    await createFailoverSender({ primary, backup }).send(message);
    expect(primary.sent).toHaveLength(1);
    expect(backup.sent).toHaveLength(0);
  });

  it("sends the same message through the backup when the primary fails, and says so", async () => {
    const backup = okSender("resend");
    const onFailover = vi.fn();
    await createFailoverSender({ primary: failingSender("smtp"), backup, onFailover }).send(
      message,
    );
    expect(backup.sent).toEqual([message]);
    expect(onFailover).toHaveBeenCalledWith("smtp", "resend");
  });

  it("fails when both senders fail", async () => {
    await expect(
      createFailoverSender({
        primary: failingSender("smtp"),
        backup: failingSender("resend"),
      }).send(message),
    ).rejects.toThrow(/every sender failed/);
  });

  it("fails with the primary's error when there is no backup", async () => {
    await expect(
      createFailoverSender({ primary: failingSender("smtp") }).send(message),
    ).rejects.toThrow(/"smtp" failed/);
  });

  it("gives up after the deadline instead of waiting for a stuck sender", async () => {
    const stuck: EmailSender = { name: "smtp", send: () => new Promise(() => undefined) };
    await expect(
      createFailoverSender({ primary: stuck, deadlineMs: 20 }).send(message),
    ).rejects.toThrow(/within 20 ms/);
  });
});

const build = () => signInCodeEmail({ code: "042917", expiresInMinutes: 10 });

describe("signInCodeEmail", () => {
  it("shows the code once per language, in Western digits, Arabic first", () => {
    const { text } = build();
    expect(text.split("042917")).toHaveLength(3);
    expect(text.indexOf("رمز")).toBeLessThan(text.indexOf("Your sign-in code"));
    expect(text).not.toMatch(/[٠-٩]/);
    expect(text).toContain("10");
  });

  it("has a subject in both languages", () => {
    const { subject } = build();
    expect(subject).toMatch(/[\u0600-\u06FF]/);
    expect(subject).toContain("Questify");
  });
});

describe("newSignInAlertEmail", () => {
  it("states the time in Riyadh with Western digits and the device", () => {
    const { text } = newSignInAlertEmail({
      at: new Date("2026-10-19T09:30:00Z"),
      userAgent: "Chrome on Windows",
    });
    expect(text).toContain("12:30");
    expect(text).toContain("(Riyadh)");
    expect(text).toContain("Chrome on Windows");
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it("says unknown when there is no user agent", () => {
    expect(newSignInAlertEmail({ at: new Date(), userAgent: null }).text).toContain("unknown");
  });
});
