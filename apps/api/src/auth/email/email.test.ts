import { afterEach, describe, expect, it, vi } from "vitest";
import { createFailoverSender } from "#src/auth/email/failover";
import { createResendSender } from "#src/auth/email/resend";
import { EmailSendError, type EmailSender } from "#src/auth/email/sender";
import { createSmtpSender, smtpTransportOptions, type SmtpTransport } from "#src/auth/email/smtp";
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

describe("exact email text", () => {
  it("writes the sign-in code email word for word, Arabic first", () => {
    expect(signInCodeEmail({ code: "042917", expiresInMinutes: 10 })).toEqual({
      subject: "رمز الدخول إلى كويستيفاي | Your Questify sign-in code",
      text: [
        "رمز الدخول الخاص بك: 042917",
        "الرمز صالح لمدة 10 دقائق. إذا لم تحاول تسجيل الدخول، تجاهل هذه الرسالة ولا تشارك الرمز مع أحد.",
        "",
        "Your sign-in code: 042917",
        "It is valid for 10 minutes. If you did not try to sign in, ignore this email and never share the code.",
      ].join("\n"),
    });
  });

  it("writes the new sign-in alert word for word, Arabic first", () => {
    const when = "19 Oct 2026, 12:30 (Riyadh)";
    expect(
      newSignInAlertEmail({ at: new Date("2026-10-19T09:30:00Z"), userAgent: "Chrome on Windows" }),
    ).toEqual({
      subject: "تسجيل دخول جديد إلى حسابك | New sign-in to your Questify account",
      text: [
        `تم تسجيل دخول جديد إلى حسابك في ${when}.`,
        "الجهاز: Chrome on Windows",
        "إذا لم تكن أنت، تواصل مع فريق كويستيفاي فورا.",
        "",
        `A new sign-in to your account happened at ${when}.`,
        "Device: Chrome on Windows",
        "If this was not you, contact the Questify team immediately.",
      ].join("\n"),
    });
  });
});

describe("email sender details", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names each sender, so logs and failover reports say which one failed", () => {
    expect(
      createSmtpSender({ user: "a@b.c", appPassword: "x", transport: { sendMail: async () => 0 } })
        .name,
    ).toBe("smtp");
    expect(createResendSender({ apiKey: "k", from: "a@b.c" }).name).toBe("resend");
    expect(createFailoverSender({ primary: okSender("a") }).name).toBe("failover");
  });

  it("makes errors that name their sender and keep the cause", async () => {
    const cause = new Error("boom");
    const error = await createSmtpSender({
      user: "a@b.c",
      appPassword: "x",
      transport: {
        sendMail: async () => {
          throw cause;
        },
      },
    })
      .send(message)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(error).toMatchObject({
      name: "EmailSendError",
      sender: "smtp",
      message: 'Email sender "smtp" failed: the SMTP server did not accept the message',
      cause,
    });
  });

  it("posts to Resend as JSON with the POST method", async () => {
    const seen: RequestInit[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await createResendSender({ apiKey: "k", from: "a@b.c", fetch: fakeFetch }).send(message);
    const [init] = seen;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string> | undefined)?.["content-type"]).toBe(
      "application/json",
    );
  });

  it("explains a failed Resend call, naming the sender and keeping the cause", async () => {
    const cause = new TypeError("fetch failed");
    const fakeFetch = (async () => {
      throw cause;
    }) as unknown as typeof fetch;
    const error = await createResendSender({ apiKey: "k", from: "a@b.c", fetch: fakeFetch })
      .send(message)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      sender: "resend",
      message: 'Email sender "resend" failed: the request failed or timed out',
      cause,
    });
    const status = await createResendSender({
      apiKey: "k",
      from: "a@b.c",
      fetch: (async () => new Response("bad", { status: 500 })) as unknown as typeof fetch,
    })
      .send(message)
      .catch((caught: unknown) => caught);
    expect(status).toMatchObject({
      sender: "resend",
      message: 'Email sender "resend" failed: the API answered 500',
    });
  });

  it("reports both failures when every sender fails, naming the failover", async () => {
    const error = await createFailoverSender({
      primary: failingSender("smtp"),
      backup: failingSender("resend"),
    })
      .send(message)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      sender: "failover",
      message: 'Email sender "failover" failed: every sender failed',
    });
    const causes = ((error as Error).cause as AggregateError).errors as EmailSendError[];
    expect(causes.map((cause) => cause.sender)).toEqual(["smtp", "resend"]);
  });

  it("names the failover in a deadline error and stops its timer once a send succeeds", async () => {
    vi.useFakeTimers();
    await createFailoverSender({ primary: okSender("smtp") }).send(message);
    expect(vi.getTimerCount()).toBe(0);

    const stuck: EmailSender = { name: "smtp", send: () => new Promise(() => undefined) };
    const pending = createFailoverSender({ primary: stuck, deadlineMs: 50 })
      .send(message)
      .catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toMatchObject({
      sender: "failover",
      message: 'Email sender "failover" failed: no sender finished within 50 ms',
    });
  });
});

describe("smtpTransportOptions", () => {
  it("connects to Gmail over TLS on 465 with the app password and a 5 second cap on every wait", () => {
    expect(smtpTransportOptions("bot@gmail.com", "app-pass")).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "bot@gmail.com", pass: "app-pass" },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    });
  });

  it("builds a real sender without opening a connection", () => {
    expect(createSmtpSender({ user: "bot@gmail.com", appPassword: "x" }).name).toBe("smtp");
  });
});
