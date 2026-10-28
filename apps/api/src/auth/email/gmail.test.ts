import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { buildMime, createGmailSender } from "#src/auth/email/gmail";
import { EmailSendError } from "#src/auth/email/sender";
import type { ServiceAccountKey } from "#src/auth/google-token";

const TOKEN_URI = "https://oauth2.googleapis.test/token";
const SEND_URI = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const message = {
  to: "sara@najd.sa",
  subject: "رمز الدخول | Your code",
  text: "Your code: 123456",
};

type Call = Readonly<{ url: string; init: RequestInit }>;

/** A fake of Google's two endpoints (the network is the boundary), recording each call. */
function google(answers: { token?: () => Response; send?: () => Response }): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url) === TOKEN_URI) {
      return answers.token?.() ?? Response.json({ access_token: "tok-1", expires_in: 3600 });
    }
    return answers.send?.() ?? Response.json({ id: "m1" });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const decodeSegment = (segment: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

describe("createGmailSender", () => {
  let key: ServiceAccountKey;
  let publicKey: string;

  beforeAll(() => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    key = {
      clientEmail: "mailer@questify.iam.test",
      privateKey: pair.privateKey,
      tokenUri: TOKEN_URI,
    };
    publicKey = pair.publicKey;
  });

  it("asks for a send-only token for the mailbox, signed with the service account key", async () => {
    const api = google({});
    await createGmailSender({
      key,
      from: "questify@nafes.com",
      fetch: api.fetch,
      now: () => 1_000_000,
    }).send(message);
    const form = new URLSearchParams(String(api.calls[0]?.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(claims)).toEqual({
      iss: "mailer@questify.iam.test",
      sub: "questify@nafes.com",
      scope: "https://www.googleapis.com/auth/gmail.send",
      aud: TOKEN_URI,
      iat: 1_000_000,
      exp: 1_003_600,
    });
    const valid = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
    expect(valid).toBe(true);
  });

  it("acts for the real mailbox when the sender address is an alias", async () => {
    const api = google({});
    await createGmailSender({
      key,
      from: "questify@nafes.com",
      actAs: "dhia@nafes.com",
      fetch: api.fetch,
    }).send(message);
    const claims = decodeSegment(
      new URLSearchParams(String(api.calls[0]?.init.body)).get("assertion")?.split(".")[1],
    );
    expect(claims["sub"]).toBe("dhia@nafes.com");
  });

  it("sends the message as base64url MIME with the bearer token", async () => {
    const api = google({});
    await createGmailSender({ key, from: "questify@nafes.com", fetch: api.fetch }).send(message);
    const send = api.calls[1];
    expect(send?.url).toBe(SEND_URI);
    expect(new Headers(send?.init.headers).get("authorization")).toBe("Bearer tok-1");
    const raw = (JSON.parse(String(send?.init.body)) as { raw: string }).raw;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("From: Questify <questify@nafes.com>\r\n");
    expect(mime).toContain("To: sara@najd.sa\r\n");
    const body = mime.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(message.text);
  });

  it("reuses one token until a minute before it expires, then asks again", async () => {
    let clock = 1_000_000;
    const api = google({});
    const sender = createGmailSender({
      key,
      from: "q@nafes.com",
      fetch: api.fetch,
      now: () => clock,
    });
    await sender.send(message);
    clock += 3_000;
    await sender.send(message);
    expect(api.calls.filter((call) => call.url === TOKEN_URI)).toHaveLength(1);
    clock += 541;
    await sender.send(message);
    expect(api.calls.filter((call) => call.url === TOKEN_URI)).toHaveLength(2);
  });

  it("shares one token request between sends that start together", async () => {
    const api = google({});
    const sender = createGmailSender({ key, from: "q@nafes.com", fetch: api.fetch });
    await Promise.all([sender.send(message), sender.send(message), sender.send(message)]);
    expect(api.calls.filter((call) => call.url === TOKEN_URI)).toHaveLength(1);
  });

  it("drops the token after a 401 so the next send asks for a fresh one", async () => {
    let first = true;
    const api = google({
      send: () => {
        const status = first ? 401 : 200;
        first = false;
        return Response.json({}, { status });
      },
    });
    const sender = createGmailSender({ key, from: "q@nafes.com", fetch: api.fetch });
    await expect(sender.send(message)).rejects.toThrow(
      'Email sender "gmail" failed: the Gmail API answered 401 (unknown)',
    );
    await sender.send(message);
    expect(api.calls.filter((call) => call.url === TOKEN_URI)).toHaveLength(2);
  });

  it("names Google's reason when the token is refused, and never the recipient or the code", async () => {
    const api = google({
      token: () => Response.json({ error: "unauthorized_client" }, { status: 401 }),
    });
    const error = await createGmailSender({ key, from: "q@nafes.com", fetch: api.fetch })
      .send(message)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailSendError);
    expect(String((error as Error).message)).toBe(
      'Email sender "gmail" failed: Google refused the token request (401 unauthorized_client)',
    );
    expect(String((error as Error).message)).not.toContain("sara@najd.sa");
    expect(api.calls).toHaveLength(1);
  });

  it("names Google's reason when a send is refused, and drops anything that is not a reason code", async () => {
    const refused = google({
      send: () =>
        Response.json(
          { error: { code: 403, status: "PERMISSION_DENIED", message: "to sara@najd.sa" } },
          { status: 403 },
        ),
    });
    await expect(
      createGmailSender({ key, from: "q@nafes.com", fetch: refused.fetch }).send(message),
    ).rejects.toThrow(
      'Email sender "gmail" failed: the Gmail API answered 403 (PERMISSION_DENIED)',
    );
    const odd = google({
      token: () => Response.json({ error: "bad\nline sara@najd.sa" }, { status: 400 }),
    });
    await expect(
      createGmailSender({ key, from: "q@nafes.com", fetch: odd.fetch }).send(message),
    ).rejects.toThrow("Google refused the token request (400 unknown)");
  });

  it("keeps a token for an hour when Google does not say how long", async () => {
    let clock = 1_000_000;
    const api = google({ token: () => Response.json({ access_token: "t" }) });
    const sender = createGmailSender({
      key,
      from: "q@nafes.com",
      fetch: api.fetch,
      now: () => clock,
    });
    await sender.send(message);
    clock += 3_000;
    await sender.send(message);
    expect(api.calls.filter((call) => call.url === TOKEN_URI)).toHaveLength(1);
  });

  it("turns a network failure into an EmailSendError at each step", async () => {
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      createGmailSender({ key, from: "q@nafes.com", fetch: down }).send(message),
    ).rejects.toThrow("the token request failed or timed out");
    let calls = 0;
    const sendDown = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ access_token: "t", expires_in: 3600 });
      }
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    await expect(
      createGmailSender({ key, from: "q@nafes.com", fetch: sendDown }).send(message),
    ).rejects.toThrow("the send request failed or timed out");
  });

  it("refuses a key that cannot sign", async () => {
    const api = google({});
    await expect(
      createGmailSender({
        key: { ...key, privateKey: "not a key" },
        from: "q@nafes.com",
        fetch: api.fetch,
      }).send(message),
    ).rejects.toThrow("the service account key could not sign");
    expect(api.calls).toEqual([]);
  });
});

describe("buildMime", () => {
  const base = {
    from: "questify@nafes.com",
    to: "sara@najd.sa",
    subject: "رمز الدخول | Your code",
    text: "x".repeat(200),
    date: new Date("2026-10-20T10:00:00Z"),
  };

  it("encodes an Arabic subject as an RFC 2047 word and the body as 76-character base64 lines", () => {
    const mime = buildMime(base);
    const subject = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(mime)?.[1] ?? "";
    expect(Buffer.from(subject, "base64").toString("utf8")).toBe(base.subject);
    expect(mime).toContain("Date: Tue, 20 Oct 2026 10:00:00 GMT\r\n");
    expect(mime).toMatch(/Message-ID: <[0-9a-f-]{36}@nafes\.com>\r\n/);
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8\r\n");
    const lines = (mime.split("\r\n\r\n")[1] ?? "").split("\r\n");
    expect(lines.every((line) => line.length <= 76)).toBe(true);
  });

  it.each(["a@x.sa, b@y.sa", "Sara <sara@najd.sa>", "a@x.sa;b@y.sa", '"sara"@najd.sa', "sara"])(
    "refuses a to that is not exactly one address (%s)",
    (to) => {
      expect(() => buildMime({ ...base, to })).toThrow("the to is not one address");
    },
  );

  it.each([
    ["to", { to: "sara@najd.sa\r\nBcc: spy@x.y" }],
    ["from", { from: "q@nafes.com\nBcc: spy@x.y" }],
    ["subject", { subject: "hi\r\nBcc: spy@x.y" }],
  ])("refuses a line break in the %s, so no header can be smuggled in", (field, change) => {
    expect(() => buildMime({ ...base, ...change })).toThrow(`the ${field} contains a line break`);
  });
});

describe("createGmailSender, the requests and their failures", () => {
  let key: ServiceAccountKey;

  beforeAll(() => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    key = {
      clientEmail: "mailer@questify.iam.test",
      privateKey: pair.privateKey,
      tokenUri: TOKEN_URI,
    };
  });

  it("is named gmail and posts a form for the token and JSON for the message", async () => {
    const api = google({});
    const sender = createGmailSender({ key, from: "q@nafes.com", fetch: api.fetch });
    expect(sender.name).toBe("gmail");
    await sender.send(message);
    const [token, send] = api.calls;
    expect(token?.init.method).toBe("POST");
    expect(new Headers(token?.init.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(send?.init.method).toBe("POST");
    expect(new Headers(send?.init.headers).get("content-type")).toBe("application/json");
  });

  it("uses the real clock when none is given", async () => {
    const api = google({});
    const before = Math.floor(Date.now() / 1000);
    await createGmailSender({ key, from: "q@nafes.com", fetch: api.fetch }).send(message);
    const claims = decodeSegment(
      new URLSearchParams(String(api.calls[0]?.init.body)).get("assertion")?.split(".")[1],
    );
    expect(Number(claims["iat"])).toBeGreaterThanOrEqual(before);
    expect(Number(claims["iat"])).toBeLessThanOrEqual(before + 5);
    const raw = (JSON.parse(String(api.calls[1]?.init.body)) as { raw: string }).raw;
    const date = /^Date: (.+)$/m.exec(Buffer.from(raw, "base64url").toString("utf8"))?.[1] ?? "";
    expect(Math.abs(Date.parse(date) / 1000 - before)).toBeLessThanOrEqual(5);
  });

  it("follows Google's token lifetime and renews exactly a minute before it ends", async () => {
    let clock = 1_000_000;
    const api = google({ token: () => Response.json({ access_token: "t", expires_in: 120 }) });
    const sender = createGmailSender({
      key,
      from: "q@nafes.com",
      fetch: api.fetch,
      now: () => clock,
    });
    await sender.send(message);
    clock += 59;
    await sender.send(message);
    expect(api.calls.filter((call) => call.url === TOKEN_URI)).toHaveLength(1);
    clock += 1;
    await sender.send(message);
    expect(api.calls.filter((call) => call.url === TOKEN_URI)).toHaveLength(2);
  });

  it("refuses a successful answer that carries no token", async () => {
    const api = google({ token: () => Response.json({ expires_in: 3600 }) });
    await expect(
      createGmailSender({ key, from: "q@nafes.com", fetch: api.fetch }).send(message),
    ).rejects.toThrow("Google refused the token request (200 unknown)");
    expect(api.calls).toHaveLength(1);
  });

  it("names itself and keeps the cause on every failure", async () => {
    const cause = new Error("ECONNRESET");
    const down = (async () => {
      throw cause;
    }) as unknown as typeof fetch;
    expect(
      await createGmailSender({ key, from: "q@nafes.com", fetch: down })
        .send(message)
        .catch((caught: unknown) => caught),
    ).toMatchObject({ sender: "gmail", cause });

    let calls = 0;
    const sendDown = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ access_token: "t", expires_in: 3600 });
      }
      throw cause;
    }) as unknown as typeof fetch;
    expect(
      await createGmailSender({ key, from: "q@nafes.com", fetch: sendDown })
        .send(message)
        .catch((caught: unknown) => caught),
    ).toMatchObject({ sender: "gmail", cause });

    const unsignable = await createGmailSender({
      key: { ...key, privateKey: "not a key" },
      from: "q@nafes.com",
      fetch: google({}).fetch,
    })
      .send(message)
      .catch((caught: unknown) => caught);
    expect(unsignable).toMatchObject({ sender: "gmail" });
    expect((unsignable as Error).cause).toBeInstanceOf(Error);

    for (const bad of [{ to: "a@x.sa, b@y.sa" }, { to: "a@x.sa\nBcc: b@y.sa" }]) {
      expect(() =>
        buildMime({ from: "q@nafes.com", subject: "s", text: "t", date: new Date(0), ...bad }),
      ).toThrow(expect.objectContaining({ sender: "gmail" }));
    }
  });
});

describe("buildMime body", () => {
  it("declares base64 and wraps the body in full 76-character lines that decode to the text", () => {
    const text = "رمز الدخول 123456 ".repeat(20);
    const mime = buildMime({
      from: "q@nafes.com",
      to: "sara@najd.sa",
      subject: "s",
      text,
      date: new Date(0),
    });
    expect(mime).toContain("\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    const lines = (mime.split("\r\n\r\n")[1] ?? "").split("\r\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(0, -1).every((line) => line.length === 76)).toBe(true);
    expect(Buffer.from(lines.join(""), "base64").toString("utf8")).toBe(text);
  });

  it("uses the sender's domain for the message id", () => {
    const mime = buildMime({
      from: "q@nafes.com",
      to: "s@najd.sa",
      subject: "s",
      text: "t",
      date: new Date(0),
    });
    expect(mime).toMatch(/\r\nMessage-ID: <[0-9a-f-]{36}@nafes\.com>\r\n/);
  });
});
