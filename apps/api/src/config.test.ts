import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const REQUIRED = {
  DATABASE_URL: "postgres://questify_app:pw@db:5432/questify",
  AUTH_SECRET: "s".repeat(32),
  DASHBOARD_ORIGIN: "https://app.questify.sa",
  SMTP_USER: "bot@gmail.com",
  SMTP_APP_PASSWORD: "app-password",
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
        smtpUser: "bot@gmail.com",
        smtpAppPassword: "app-password",
        resend: undefined,
        securityAlertEmail: undefined,
      },
    });
  });

  it("reads every setting from the environment", () => {
    const config = loadConfig({
      ...REQUIRED,
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

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });

  it.each(Object.keys(REQUIRED))("names %s when it is missing or blank", (name) => {
    expect(() => loadConfig({ ...REQUIRED, [name]: undefined })).toThrow(new RegExp(name));
    expect(() => loadConfig({ ...REQUIRED, [name]: "  " })).toThrow(new RegExp(name));
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
      loadConfig({ ...REQUIRED, NODE_ENV: "production", TRUST_PROXY_HOPS: "2" }),
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
});
