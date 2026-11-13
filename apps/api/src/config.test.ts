import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "#src/config";

const REQUIRED = {
  DATABASE_URL: "postgres://questify_app:pw@db:5432/questify",
  AUTH_SECRET: "s".repeat(32),
  QR_SECRET: "q".repeat(32),
  REWARD_CODE_SECRET: "r".repeat(32),
  DASHBOARD_ORIGIN: "https://app.questify.sa",
  GMAIL_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: "service_account",
    client_email: "mailer@questify.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    token_uri: "https://oauth2.googleapis.com/token",
  }),
  MAIL_FROM: "questify@nafes.com",
};
const REDIS = { REDIS_URL: "redis://cache:6379" };
const MSEGAT = {
  MSEGAT_USERNAME: "nafes",
  MSEGAT_API_KEY: "test-key",
  MSEGAT_SENDER: "Questify",
};

/** A fresh private key in PKCS#8 PEM. */
const pem = (type: "ec" | "rsa", curve = "prime256v1"): string =>
  (type === "ec"
    ? generateKeyPairSync("ec", { namedCurve: curve })
    : generateKeyPairSync("rsa", { modulusLength: 2048 })
  ).privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

/** The message `loadConfig` refuses the settings with, or "no error". */
const errorOf = (env: Record<string, string>): string => {
  try {
    loadConfig({ ...REQUIRED, ...env });
  } catch (error) {
    return (error as Error).message;
  }
  return "no error";
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
        keyId: 1,
        previous: undefined,
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
      rewardCodes: { current: { id: 1, secret: REQUIRED.REWARD_CODE_SECRET }, previous: undefined },
      msegat: undefined,
      msegatPromoSender: undefined,
      redisUrl: undefined,
      push: { apns: undefined, fcm: undefined },
      storage: undefined,
      integrity: { play: undefined, appAttest: undefined },
    });
  });

  it("reads every setting from the environment", () => {
    const config = loadConfig({
      ...REQUIRED,
      ...MSEGAT,
      ...REDIS,
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

  it("refuses a Gmail key whose token_uri is not Google's own address", () => {
    for (const token_uri of [
      "http://oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com.evil.test/token",
      "https://oauth2.googleapis.com/token/",
      "https://oauth2.googleapis.com/token?x=1",
      "https://evil.test/",
    ]) {
      const key = JSON.stringify({ ...JSON.parse(REQUIRED.GMAIL_SERVICE_ACCOUNT_KEY), token_uri });
      expect(errorOf({ GMAIL_SERVICE_ACCOUNT_KEY: key }), token_uri).toBe(
        "GMAIL_SERVICE_ACCOUNT_KEY's token_uri must be https://oauth2.googleapis.com/token.",
      );
    }
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

  it.each(["QR_SECRET", "REWARD_CODE_SECRET"] as const)(
    "requires a %s of at least 32 characters",
    (name) => {
      const { [name]: _omitted, ...without } = REQUIRED;
      expect(() => loadConfig(without)).toThrow(new RegExp(`${name} is required`));
      expect(() => loadConfig({ ...REQUIRED, [name]: "x".repeat(31) })).toThrow(
        new RegExp(`${name} must be at least 32`),
      );
      expect(loadConfig({ ...REQUIRED, [name]: "x".repeat(32) })).toBeDefined();
    },
  );

  describe("reward code keys (ADR-725)", () => {
    const PREVIOUS = {
      REWARD_CODE_KEY_ID: "2",
      REWARD_CODE_PREVIOUS_SECRET: "p".repeat(32),
      REWARD_CODE_PREVIOUS_KEY_ID: "1",
    };

    it("reads the current key id and the previous key during a rotation", () => {
      expect(loadConfig({ ...REQUIRED, REWARD_CODE_KEY_ID: "255" }).rewardCodes).toEqual({
        current: { id: 255, secret: REQUIRED.REWARD_CODE_SECRET },
        previous: undefined,
      });
      expect(loadConfig({ ...REQUIRED, ...PREVIOUS }).rewardCodes).toEqual({
        current: { id: 2, secret: REQUIRED.REWARD_CODE_SECRET },
        previous: { id: 1, secret: "p".repeat(32) },
      });
    });

    it.each([
      [{ REWARD_CODE_KEY_ID: "0" }, /REWARD_CODE_KEY_ID must be a whole number from 1 to 255/],
      [{ REWARD_CODE_KEY_ID: "256" }, /REWARD_CODE_KEY_ID must be a whole number from 1 to 255/],
      [{ REWARD_CODE_KEY_ID: "1.5" }, /REWARD_CODE_KEY_ID must be a whole number/],
      [
        { ...PREVIOUS, REWARD_CODE_PREVIOUS_KEY_ID: "0" },
        /REWARD_CODE_PREVIOUS_KEY_ID must be a whole/,
      ],
      [
        { ...PREVIOUS, REWARD_CODE_PREVIOUS_KEY_ID: "x" },
        /REWARD_CODE_PREVIOUS_KEY_ID must be a whole/,
      ],
      [{ ...PREVIOUS, REWARD_CODE_PREVIOUS_KEY_ID: "" }, /go together/],
      [{ ...PREVIOUS, REWARD_CODE_PREVIOUS_SECRET: " " }, /go together/],
      [{ ...PREVIOUS, REWARD_CODE_PREVIOUS_KEY_ID: "2" }, /must differ from REWARD_CODE_KEY_ID/],
      [
        { ...PREVIOUS, REWARD_CODE_PREVIOUS_SECRET: REQUIRED.REWARD_CODE_SECRET },
        /REWARD_CODE_PREVIOUS_SECRET must differ from REWARD_CODE_SECRET/,
      ],
      [
        { ...PREVIOUS, REWARD_CODE_PREVIOUS_SECRET: "p".repeat(31) },
        /REWARD_CODE_PREVIOUS_SECRET must be at least 32/,
      ],
    ])("refuses %j", (env, message) => {
      expect(errorOf(env)).toMatch(message);
    });

    it("never prints a secret in a refusal", () => {
      const secret = "p".repeat(31);
      expect(errorOf({ ...PREVIOUS, REWARD_CODE_PREVIOUS_SECRET: secret })).not.toContain(secret);
      expect(
        errorOf({ ...PREVIOUS, REWARD_CODE_PREVIOUS_SECRET: REQUIRED.REWARD_CODE_SECRET }),
      ).not.toContain(REQUIRED.REWARD_CODE_SECRET);
    });
  });

  describe("opt-out key ids (w2-crypto 4)", () => {
    const PREVIOUS = {
      AUTH_KEY_ID: "2",
      AUTH_PREVIOUS_SECRET: "q".repeat(32),
      AUTH_PREVIOUS_KEY_ID: "1",
    };

    it("reads the key id (default 1) and the previous secret during a rotation", () => {
      expect(loadConfig(REQUIRED).auth).toMatchObject({ keyId: 1, previous: undefined });
      expect(loadConfig({ ...REQUIRED, AUTH_KEY_ID: "255" }).auth.keyId).toBe(255);
      expect(loadConfig({ ...REQUIRED, ...PREVIOUS }).auth).toMatchObject({
        secret: REQUIRED.AUTH_SECRET,
        keyId: 2,
        previous: { id: 1, secret: "q".repeat(32) },
      });
    });

    it.each([
      [{ AUTH_KEY_ID: "0" }, /AUTH_KEY_ID must be a whole number from 1 to 255/],
      [{ AUTH_KEY_ID: "256" }, /AUTH_KEY_ID must be a whole number from 1 to 255/],
      [{ AUTH_KEY_ID: "x" }, /AUTH_KEY_ID must be a whole number/],
      [{ ...PREVIOUS, AUTH_PREVIOUS_KEY_ID: "0" }, /AUTH_PREVIOUS_KEY_ID must be a whole/],
      [{ ...PREVIOUS, AUTH_PREVIOUS_KEY_ID: "x" }, /AUTH_PREVIOUS_KEY_ID must be a whole/],
      [{ AUTH_PREVIOUS_SECRET: "q".repeat(32) }, /go together/],
      [{ AUTH_PREVIOUS_KEY_ID: "2" }, /go together/],
      [
        { ...PREVIOUS, AUTH_PREVIOUS_KEY_ID: "2" },
        /AUTH_PREVIOUS_KEY_ID must differ from AUTH_KEY_ID/,
      ],
      [
        { ...PREVIOUS, AUTH_PREVIOUS_SECRET: REQUIRED.AUTH_SECRET },
        /AUTH_PREVIOUS_SECRET must differ from AUTH_SECRET/,
      ],
      [
        { ...PREVIOUS, AUTH_PREVIOUS_SECRET: "q".repeat(31) },
        /AUTH_PREVIOUS_SECRET must be at least 32/,
      ],
    ])("refuses %j", (env, message) => {
      expect(errorOf(env)).toMatch(message);
    });

    it("names a refused key id setting but never echoes its value", () => {
      expect(errorOf({ AUTH_KEY_ID: "256" })).not.toContain("256");
      expect(errorOf({ AUTH_KEY_ID: "hunter2" })).not.toContain("hunter2");
      expect(errorOf({ ...PREVIOUS, AUTH_PREVIOUS_KEY_ID: "999" })).not.toContain("999");
    });

    it("never prints a secret in a refusal", () => {
      const short = "q".repeat(31);
      expect(errorOf({ ...PREVIOUS, AUTH_PREVIOUS_SECRET: short })).not.toContain(short);
      expect(errorOf({ ...PREVIOUS, AUTH_PREVIOUS_SECRET: REQUIRED.AUTH_SECRET })).not.toContain(
        REQUIRED.AUTH_SECRET,
      );
    });
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
      loadConfig({
        ...REQUIRED,
        ...MSEGAT,
        ...REDIS,
        NODE_ENV: "production",
        TRUST_PROXY_HOPS: "2",
      }),
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

  describe("the photo bucket (T-301b)", () => {
    const S3 = {
      S3_ENDPOINT: "https://s3.riyadh-1.example.test",
      S3_BUCKET: "questify-media-staging",
      S3_REGION: "riyadh-1",
      S3_ACCESS_KEY_ID: "AKIDTEST",
      S3_SECRET_ACCESS_KEY: "secret-test",
    };

    it("reads all five together, path-style by default", () => {
      expect(loadConfig({ ...REQUIRED, ...S3 }).storage).toEqual({
        endpoint: "https://s3.riyadh-1.example.test",
        bucket: "questify-media-staging",
        region: "riyadh-1",
        accessKeyId: "AKIDTEST",
        secretAccessKey: "secret-test",
        urlStyle: "path",
      });
      expect(loadConfig({ ...REQUIRED, ...S3, S3_URL_STYLE: "virtual" }).storage?.urlStyle).toBe(
        "virtual",
      );
    });

    it("is off with none, and refuses some without the others", () => {
      expect(loadConfig(REQUIRED).storage).toBeUndefined();
      expect(() => loadConfig({ ...REQUIRED, ...S3, S3_SECRET_ACCESS_KEY: "" })).toThrow(
        /required together/,
      );
    });

    it("refuses a bad endpoint, bucket, region or style, and http in production", () => {
      for (const [name, value] of [
        ["S3_ENDPOINT", "not a url"],
        ["S3_ENDPOINT", "https://s3.example.test/bucket"],
        ["S3_ENDPOINT", "ftp://s3.example.test"],
        ["S3_BUCKET", "Bad_Bucket"],
        ["S3_REGION", "riyadh 1"],
        ["S3_URL_STYLE", "dns"],
      ] as const) {
        expect(() => loadConfig({ ...REQUIRED, ...S3, [name]: value }), name).toThrow(/S3_/);
      }
      expect(
        loadConfig({ ...REQUIRED, ...S3, S3_ENDPOINT: "http://127.0.0.1:9000" }).storage?.endpoint,
      ).toBe("http://127.0.0.1:9000");
      expect(() =>
        loadConfig({
          ...REQUIRED,
          ...MSEGAT,
          ...REDIS,
          NODE_ENV: "production",
          TRUST_PROXY_HOPS: "1",
          ...S3,
          S3_ENDPOINT: "http://s3.example.test",
        }),
      ).toThrow(/https/);
    });
  });

  describe("Msegat", () => {
    const PRODUCTION = { ...REQUIRED, ...REDIS, NODE_ENV: "production", TRUST_PROXY_HOPS: "1" };

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

    it("reads the promotional sender, and refuses one that is the service sender or has no account", () => {
      expect(loadConfig({ ...REQUIRED, ...MSEGAT }).msegatPromoSender).toBeUndefined();
      expect(
        loadConfig({ ...REQUIRED, ...MSEGAT, MSEGAT_PROMO_SENDER: " Questify-AD " })
          .msegatPromoSender,
      ).toBe("Questify-AD");
      for (const same of ["Questify", "questify", " QUESTIFY "]) {
        expect(() => loadConfig({ ...REQUIRED, ...MSEGAT, MSEGAT_PROMO_SENDER: same })).toThrow(
          /must not be MSEGAT_SENDER/,
        );
      }
      expect(() => loadConfig({ ...REQUIRED, MSEGAT_PROMO_SENDER: "Questify-AD" })).toThrow(
        /needs the Msegat account/,
      );
    });

    it("refuses a partial account anywhere", () => {
      for (const missing of Object.keys(MSEGAT)) {
        const partial = { ...REQUIRED, ...MSEGAT, [missing]: " " };
        expect(() => loadConfig(partial)).toThrow(/required together/);
      }
    });
  });

  describe("Redis", () => {
    const PRODUCTION = { ...REQUIRED, ...MSEGAT, NODE_ENV: "production", TRUST_PROXY_HOPS: "1" };

    it("is optional outside production and required in production", () => {
      expect(loadConfig(REQUIRED).redisUrl).toBeUndefined();
      expect(() => loadConfig(PRODUCTION)).toThrow("REDIS_URL is required.");
      expect(loadConfig({ ...PRODUCTION, ...REDIS }).redisUrl).toBe("redis://cache:6379");
    });

    it("takes redis:// and rediss:// only", () => {
      expect(loadConfig({ ...REQUIRED, REDIS_URL: "rediss://cache:6380" }).redisUrl).toBe(
        "rediss://cache:6380",
      );
      expect(() => loadConfig({ ...REQUIRED, REDIS_URL: "http://cache" })).toThrow(/redis:\/\//);
      expect(() => loadConfig({ ...REQUIRED, REDIS_URL: "not a url" })).toThrow(
        /REDIS_URL must be/,
      );
    });
  });

  describe("push providers", () => {
    let p8: string;
    let rsa: string;
    let account: Record<string, string>;
    let apns: Record<string, string>;

    beforeAll(() => {
      p8 = pem("ec");
      rsa = pem("rsa");
      apns = {
        APNS_KEY_ID: "ABC123DEFG",
        APNS_TEAM_ID: "DEF123GHIJ",
        APNS_PRIVATE_KEY: p8,
        APNS_TOPIC: "app.questify.mobile",
      };
      account = {
        type: "service_account",
        project_id: "questify-prod",
        client_email: "push@questify-prod.iam.gserviceaccount.com",
        private_key: rsa,
        token_uri: "https://oauth2.googleapis.com/token",
      };
    });

    it("starts with none set, in production too, and sends nothing", () => {
      expect(loadConfig(REQUIRED).push).toEqual({ apns: undefined, fcm: undefined });
      const production = loadConfig({
        ...REQUIRED,
        ...MSEGAT,
        ...REDIS,
        NODE_ENV: "production",
        TRUST_PROXY_HOPS: "1",
      });
      expect(production.push).toEqual({ apns: undefined, fcm: undefined });
    });

    it("reads the APNs key as PEM or as its base64, parsed into a key object", () => {
      for (const key of [p8, Buffer.from(p8).toString("base64")]) {
        const settings = loadConfig({ ...REQUIRED, ...apns, APNS_PRIVATE_KEY: key }).push.apns;
        expect(settings).toMatchObject({
          keyId: "ABC123DEFG",
          teamId: "DEF123GHIJ",
          topic: "app.questify.mobile",
        });
        expect(settings?.privateKey.asymmetricKeyType).toBe("ec");
        expect(settings?.privateKey.type).toBe("private");
      }
    });

    it.each(["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY", "APNS_TOPIC"])(
      "refuses to start when %s is the one missing",
      (name) => {
        const partial = { ...apns, [name]: " " };
        expect(errorOf(partial)).toBe(
          `APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_TOPIC are required together for iPhone push; missing: ${name}.`,
        );
      },
    );

    it("refuses a key that is not an EC P-256 private key, without echoing it", () => {
      const wrong = [
        rsa,
        pem("ec", "secp384r1"),
        "not a key",
        Buffer.from("junk").toString("base64"),
      ];
      for (const key of wrong) {
        expect(errorOf({ ...apns, APNS_PRIVATE_KEY: key })).toBe(
          "APNS_PRIVATE_KEY must be the .p8 key from the Apple Developer account: an EC P-256 private key in PEM, or its base64.",
        );
      }
    });

    it("refuses ids that are not Apple's 10 characters and a topic that is not a bundle id", () => {
      expect(errorOf({ ...apns, APNS_KEY_ID: "abc123defg" })).toBe(
        "APNS_KEY_ID must be the 10-character id from the Apple Developer account (capital letters and digits).",
      );
      expect(errorOf({ ...apns, APNS_TEAM_ID: "DEF123GHI" })).toContain("APNS_TEAM_ID must be");
      expect(errorOf({ ...apns, APNS_TOPIC: "questify" })).toBe(
        "APNS_TOPIC must be the app's bundle id, like app.questify.mobile.",
      );
    });

    it("reads the FCM service account as JSON or as its base64", () => {
      const json = JSON.stringify(account);
      for (const value of [json, Buffer.from(json).toString("base64")]) {
        const fcm = loadConfig({ ...REQUIRED, FCM_SERVICE_ACCOUNT: value }).push.fcm;
        expect(fcm).toMatchObject({
          projectId: "questify-prod",
          key: {
            clientEmail: "push@questify-prod.iam.gserviceaccount.com",
            tokenUri: "https://oauth2.googleapis.com/token",
          },
        });
        expect(
          typeof fcm?.key.privateKey === "object" && fcm.key.privateKey.asymmetricKeyType,
        ).toBe("rsa");
      }
    });

    it("refuses a malformed service account, naming the field and never a value", () => {
      const refuse = (change: Record<string, unknown>) =>
        errorOf({ FCM_SERVICE_ACCOUNT: JSON.stringify({ ...account, ...change }) });
      expect(refuse({ private_key: pem("ec") })).toBe(
        "FCM_SERVICE_ACCOUNT's private_key is not an RSA private key in PEM: download the key file again.",
      );
      expect(refuse({ project_id: "Questify Prod" })).toBe(
        "FCM_SERVICE_ACCOUNT's project_id is not a Google Cloud project id.",
      );
      for (const token_uri of [
        "http://oauth2.googleapis.com/token",
        "https://oauth2.googleapis.com.evil.test/token",
        "https://oauth2.googleapis.com/token/",
        "https://oauth2.googleapis.com/token?x=1",
        "https://evil.test/",
      ]) {
        expect(refuse({ token_uri }), token_uri).toBe(
          "FCM_SERVICE_ACCOUNT's token_uri must be https://oauth2.googleapis.com/token.",
        );
      }
      expect(refuse({ project_id: "" })).toBe("FCM_SERVICE_ACCOUNT is missing project_id.");
      expect(errorOf({ FCM_SERVICE_ACCOUNT: "{ not json" })).toContain(
        "FCM_SERVICE_ACCOUNT is not valid JSON",
      );
      expect(errorOf({ FCM_SERVICE_ACCOUNT: "bm90IGpzb24=" })).toContain(
        "FCM_SERVICE_ACCOUNT is not valid JSON",
      );
    });
  });

  describe("device integrity (T-812)", () => {
    let account: Record<string, string>;
    beforeAll(() => {
      account = {
        type: "service_account",
        client_email: "integrity@questify-prod.iam.gserviceaccount.com",
        private_key: pem("rsa"),
        token_uri: "https://oauth2.googleapis.com/token",
      };
    });
    const play = () => ({
      PLAY_INTEGRITY_SERVICE_ACCOUNT: JSON.stringify(account),
      PLAY_INTEGRITY_PACKAGE: "app.questify.mobile",
    });
    const apple = { APP_ATTEST_TEAM_ID: "ABCDE12345", APP_ATTEST_BUNDLE_ID: "app.questify.mobile" };

    it("is off for both platforms without keys", () => {
      expect(loadConfig(REQUIRED).integrity).toEqual({ play: undefined, appAttest: undefined });
    });

    it("reads Play Integrity as JSON or base64, and App Attest with development keys off by default", () => {
      const json = play();
      const base64 = {
        ...json,
        PLAY_INTEGRITY_SERVICE_ACCOUNT: Buffer.from(json.PLAY_INTEGRITY_SERVICE_ACCOUNT).toString(
          "base64",
        ),
      };
      for (const env of [json, base64]) {
        expect(loadConfig({ ...REQUIRED, ...env }).integrity.play).toMatchObject({
          packageName: "app.questify.mobile",
          key: {
            clientEmail: account["client_email"],
            tokenUri: "https://oauth2.googleapis.com/token",
          },
        });
      }
      expect(loadConfig({ ...REQUIRED, ...apple }).integrity.appAttest).toEqual({
        appId: "ABCDE12345.app.questify.mobile",
        development: false,
      });
      expect(
        loadConfig({ ...REQUIRED, ...apple, APP_ATTEST_DEVELOPMENT: "true" }).integrity.appAttest
          ?.development,
      ).toBe(true);
    });

    it("wants each pair all or none, and names the setting, never its value", () => {
      expect(errorOf({ PLAY_INTEGRITY_PACKAGE: "app.questify.mobile" })).toBe(
        "PLAY_INTEGRITY_SERVICE_ACCOUNT, PLAY_INTEGRITY_PACKAGE are required together for Play Integrity; missing: PLAY_INTEGRITY_SERVICE_ACCOUNT.",
      );
      expect(errorOf({ APP_ATTEST_TEAM_ID: "ABCDE12345" })).toBe(
        "APP_ATTEST_TEAM_ID, APP_ATTEST_BUNDLE_ID are required together for App Attest; missing: APP_ATTEST_BUNDLE_ID.",
      );
      expect(errorOf({ ...play(), PLAY_INTEGRITY_PACKAGE: "questify" })).toBe(
        "PLAY_INTEGRITY_PACKAGE must be the app's Android package, like app.questify.mobile.",
      );
      const refuse = (change: Record<string, string>) =>
        errorOf({
          ...play(),
          PLAY_INTEGRITY_SERVICE_ACCOUNT: JSON.stringify({ ...account, ...change }),
        });
      expect(refuse({ private_key: pem("ec") })).toContain("private_key is not an RSA private key");
      expect(refuse({ token_uri: "https://evil.test/token" })).toBe(
        "PLAY_INTEGRITY_SERVICE_ACCOUNT's token_uri must be https://oauth2.googleapis.com/token.",
      );
      expect(errorOf({ ...apple, APP_ATTEST_TEAM_ID: "abc" })).toContain(
        "APP_ATTEST_TEAM_ID must be",
      );
      expect(errorOf({ ...apple, APP_ATTEST_BUNDLE_ID: "questify" })).toContain(
        "APP_ATTEST_BUNDLE_ID must be",
      );
      expect(errorOf({ ...apple, APP_ATTEST_DEVELOPMENT: "yes" })).toBe(
        'APP_ATTEST_DEVELOPMENT must be "true" or "false".',
      );
      expect(
        errorOf({
          ...apple,
          ...REDIS,
          ...MSEGAT,
          NODE_ENV: "production",
          TRUST_PROXY_HOPS: "1",
          APP_ATTEST_DEVELOPMENT: "true",
        }),
      ).toBe("APP_ATTEST_DEVELOPMENT cannot be true in production.");
    });
  });
});
