import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const REQUIRED = {
  DATABASE_URL: "postgres://questify_app:pw@db:5432/questify",
  AUTH_SECRET: "s".repeat(32),
  QR_SECRET: "q".repeat(32),
  DASHBOARD_ORIGIN: "https://app.questify.sa",
  GMAIL_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: "service_account",
    client_email: "mailer@questify.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    token_uri: "https://oauth2.googleapis.com/token",
  }),
  MAIL_FROM: "questify@nafes.com",
};
const MSEGAT = {
  MSEGAT_USERNAME: "nafes",
  MSEGAT_API_KEY: "test-key",
  MSEGAT_SENDER: "Questify",
};

describe("loadConfig", () => {
  it("uses safe defaults for everything that has one", () => {
    expect(loadConfig(REQUIRED)).toEqual({
      nodeEnv: "development",
      host: "0.0.0.0",
      port: 3000,
      minAppVersion: "1.0.0",
      releaseSha: "dev",
      databaseUrl: REQUIRED.DATABASE_URL,
      databasePoolSize: 10,
      trustProxyHops: 1,
      auth: {
        secret: REQUIRED.AUTH_SECRET,
        dashboardOrigin: "https://app.questify.sa",
        gmail: {
          key: {
            clientEmail: "mailer@questify.iam.gserviceaccount.com",
            privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
            tokenUri: "https://oauth2.googleapis.com/token",
          },
          from: "questify@nafes.com",
          actAs: undefined,
        },
        resend: undefined,
        securityAlertEmail: undefined,
      },
      qrSecret: REQUIRED.QR_SECRET,
      msegat: undefined,
    });
  });

  it("reads every setting from the environment", () => {
    const config = loadConfig({
      ...REQUIRED,
      ...MSEGAT,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "8080",
      MIN_APP_VERSION: "1.4.2",
      RELEASE_SHA: "abc1234",
      TRUST_PROXY_HOPS: "2",
      RESEND_API_KEY: "re_key",
      RESEND_FROM: "no-reply@questify.sa",
      SECURITY_ALERT_EMAIL: "security@questify.sa",
    });
    expect(config).toMatchObject({
      nodeEnv: "production",
      host: "127.0.0.1",
      port: 8080,
      minAppVersion: "1.4.2",
      releaseSha: "abc1234",
      trustProxyHops: 2,
      auth: {
        resend: { apiKey: "re_key", from: "no-reply@questify.sa" },
        securityAlertEmail: "security@questify.sa",
      },
    });
  });

  it.each(["0", "65536", "-1", "abc", "30.5", ""])("rejects the port %j", (port) => {
    expect(() => loadConfig({ ...REQUIRED, PORT: port })).toThrow(/PORT/);
  });

  it.each(["banana", "1", ""])("rejects the minimum app version %j", (version) => {
    expect(() => loadConfig({ ...REQUIRED, MIN_APP_VERSION: version })).toThrow(/MIN_APP_VERSION/);
  });

  it("reads the mailbox to act for when the sender address is an alias", () => {
    expect(loadConfig({ ...REQUIRED, GMAIL_ACT_AS: "dhia@nafes.com" }).auth.gmail.actAs).toBe(
      "dhia@nafes.com",
    );
  });

  it("refuses a missing or broken Gmail key without echoing it", () => {
    const without: Record<string, string> = { ...REQUIRED };
    delete without["GMAIL_SERVICE_ACCOUNT_KEY"];
    expect(() => loadConfig(without)).toThrow("GMAIL_SERVICE_ACCOUNT_KEY is required.");
    expect(() => loadConfig({ ...REQUIRED, GMAIL_SERVICE_ACCOUNT_KEY: "{secret-ish" })).toThrow(
      /^GMAIL_SERVICE_ACCOUNT_KEY is not valid JSON: paste the whole key file/,
    );
    expect(() =>
      loadConfig({ ...REQUIRED, GMAIL_SERVICE_ACCOUNT_KEY: '{"type":"authorized_user"}' }),
    ).toThrow('its "type" must be "service_account"');
    expect(() =>
      loadConfig({
        ...REQUIRED,
        GMAIL_SERVICE_ACCOUNT_KEY: '{"type":"service_account","client_email":"a@b.c"}',
      }),
    ).toThrow("GMAIL_SERVICE_ACCOUNT_KEY is missing private_key, token_uri.");
  });

  it("refuses a sender that is not one plain email address", () => {
    for (const bad of ["questify", "Questify <q@nafes.com>", "q@nafes.com\nBcc: x@y.z", "a@b"]) {
      expect(() => loadConfig({ ...REQUIRED, MAIL_FROM: bad })).toThrow(
        /MAIL_FROM must be one email address/,
      );
    }
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });

  it.each(Object.keys(REQUIRED))("names %s when it is missing or blank", (name) => {
    expect(() => loadConfig({ ...REQUIRED, [name]: undefined })).toThrow(new RegExp(name));
    expect(() => loadConfig({ ...REQUIRED, [name]: "  " })).toThrow(new RegExp(name));
  });

  it("requires a QR_SECRET of at least 32 characters", () => {
    const { QR_SECRET: _omitted, ...withoutQr } = REQUIRED;
    expect(() => loadConfig(withoutQr)).toThrow(/QR_SECRET is required/);
    expect(() => loadConfig({ ...REQUIRED, QR_SECRET: "x".repeat(31) })).toThrow(
      /QR_SECRET must be at least 32/,
    );
  });

  it("rejects an AUTH_SECRET shorter than 32 characters", () => {
    expect(() => loadConfig({ ...REQUIRED, AUTH_SECRET: "x".repeat(31) })).toThrow(/AUTH_SECRET/);
  });

  it.each(["https://app.questify.sa/", "https://app.questify.sa/x", "app.questify.sa", "nonsense"])(
    "rejects the dashboard origin %j",
    (value) => {
      expect(() => loadConfig({ ...REQUIRED, DASHBOARD_ORIGIN: value })).toThrow(
        /DASHBOARD_ORIGIN/,
      );
    },
  );

  it("accepts a local dashboard origin with a port", () => {
    const config = loadConfig({ ...REQUIRED, DASHBOARD_ORIGIN: "http://localhost:3001" });
    expect(config.auth.dashboardOrigin).toBe("http://localhost:3001");
  });

  it("refuses a Resend key without its From address, and the other way round", () => {
    expect(() => loadConfig({ ...REQUIRED, RESEND_API_KEY: "re_key" })).toThrow(/RESEND_FROM/);
    expect(() => loadConfig({ ...REQUIRED, RESEND_FROM: "a@questify.sa" })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it.each(["-1", "11", "x", "1.5"])("rejects TRUST_PROXY_HOPS %j", (value) => {
    expect(() => loadConfig({ ...REQUIRED, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it("requires TRUST_PROXY_HOPS in production, because a wrong guess makes everyone share one address", () => {
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: "production" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(
      loadConfig({ ...REQUIRED, ...MSEGAT, NODE_ENV: "production", TRUST_PROXY_HOPS: "2" }),
    ).toMatchObject({
      trustProxyHops: 2,
    });
    expect(loadConfig({ ...REQUIRED, NODE_ENV: "development" }).trustProxyHops).toBe(1);
  });

  it.each(["0", "201", "x", "2.5"])("rejects DATABASE_POOL_SIZE %j", (value) => {
    expect(() => loadConfig({ ...REQUIRED, DATABASE_POOL_SIZE: value })).toThrow(
      /DATABASE_POOL_SIZE/,
    );
  });

  it("reads the pool size, from 1 to 200", () => {
    expect(loadConfig({ ...REQUIRED, DATABASE_POOL_SIZE: "1" }).databasePoolSize).toBe(1);
    expect(loadConfig({ ...REQUIRED, DATABASE_POOL_SIZE: "200" }).databasePoolSize).toBe(200);
  });

  it("accepts zero proxies", () => {
    expect(loadConfig({ ...REQUIRED, TRUST_PROXY_HOPS: "0" }).trustProxyHops).toBe(0);
  });

  describe("Msegat", () => {
    const PRODUCTION = { ...REQUIRED, NODE_ENV: "production", TRUST_PROXY_HOPS: "1" };

    it("reads the account when all three are set", () => {
      expect(loadConfig({ ...REQUIRED, ...MSEGAT }).msegat).toEqual({
        userName: "nafes",
        apiKey: "test-key",
        sender: "Questify",
      });
    });

    it("is optional outside production", () => {
      expect(loadConfig(REQUIRED).msegat).toBeUndefined();
    });

    it("is required in production", () => {
      expect(() => loadConfig(PRODUCTION)).toThrow(
        /MSEGAT_USERNAME.*required together in production/,
      );
      expect(loadConfig({ ...PRODUCTION, ...MSEGAT }).msegat?.sender).toBe("Questify");
    });

    it("refuses a partial account anywhere", () => {
      for (const missing of Object.keys(MSEGAT)) {
        const partial = { ...REQUIRED, ...MSEGAT, [missing]: " " };
        expect(() => loadConfig(partial)).toThrow(/required together/);
      }
    });
  });
});
