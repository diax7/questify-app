import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createGoogleTokenSource,
  GoogleTokenError,
  parseServiceAccountKey,
  readServiceAccount,
  type ServiceAccountKey,
} from "#src/auth/google-token";

const TOKEN_URI = "https://oauth2.googleapis.test/token";
const valid = {
  type: "service_account",
  project_id: "questify-test",
  client_email: "m@p.iam.gserviceaccount.com",
  private_key: "PEM",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("parseServiceAccountKey", () => {
  it("reads the three fields a token request needs", () => {
    expect(parseServiceAccountKey(JSON.stringify(valid), "GMAIL_SERVICE_ACCOUNT_KEY")).toEqual({
      clientEmail: "m@p.iam.gserviceaccount.com",
      privateKey: "PEM",
      tokenUri: "https://oauth2.googleapis.com/token",
    });
  });

  it("names the setting in each refusal and never echoes the value", () => {
    expect(() => parseServiceAccountKey("{ PEM", "FCM_SERVICE_ACCOUNT")).toThrow(
      "FCM_SERVICE_ACCOUNT is not valid JSON: paste the whole key file, from the first { to the last }.",
    );
    expect(() => parseServiceAccountKey("null", "GMAIL_SERVICE_ACCOUNT_KEY")).toThrow(
      'GMAIL_SERVICE_ACCOUNT_KEY is not a service account key (its "type" must be "service_account").',
    );
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ ...valid, private_key: "" }),
        "GMAIL_SERVICE_ACCOUNT_KEY",
      ),
    ).toThrow("GMAIL_SERVICE_ACCOUNT_KEY is missing private_key.");
  });
});

describe("readServiceAccount", () => {
  it("returns exactly the fields asked for", () => {
    expect(readServiceAccount(JSON.stringify(valid), "X", ["project_id", "token_uri"])).toEqual({
      project_id: "questify-test",
      token_uri: "https://oauth2.googleapis.com/token",
    });
  });

  it("lists every missing or non-text field", () => {
    expect(() =>
      readServiceAccount(JSON.stringify({ ...valid, project_id: 7 }), "FCM_SERVICE_ACCOUNT", [
        "project_id",
        "client_id",
      ]),
    ).toThrow("FCM_SERVICE_ACCOUNT is missing project_id, client_id.");
  });
});

/** Google's token endpoint (the network is the boundary), counting its calls. */
const google = (answer: () => Response) => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return answer();
  }) as unknown as typeof fetch;
  return { fetch: fake, calls: () => calls };
};

describe("createGoogleTokenSource", () => {
  let key: ServiceAccountKey;

  beforeAll(() => {
    key = {
      clientEmail: "push@questify-test.iam.gserviceaccount.com",
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
      tokenUri: TOKEN_URI,
    };
  });

  const source = (fetcher: typeof fetch, now = () => 1_000_000) =>
    createGoogleTokenSource({
      key,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      timeoutMs: 1000,
      renewMarginSeconds: 300,
      fetch: fetcher,
      now,
    });

  it("drops only the token it is told about, so a newer one is kept", async () => {
    let issued = 0;
    const api = google(() => {
      issued += 1;
      return Response.json({ access_token: `t${issued}`, expires_in: 3600 });
    });
    const tokens = source(api.fetch);
    expect(await tokens.get()).toBe("t1");
    tokens.drop("t0");
    expect(await tokens.get()).toBe("t1");
    tokens.drop("t1");
    expect(await tokens.get()).toBe("t2");
    expect(api.calls()).toBe(2);
  });

  it("says why a token could not be had: refused with Google's status and code, or unreachable", async () => {
    const refused = await source(
      google(() => Response.json({ error: "invalid_grant" }, { status: 400 })).fetch,
    )
      .get()
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GoogleTokenError);
    expect(refused).toMatchObject({ failure: "refused", status: 400, code: "invalid_grant" });
    const cause = new TypeError("fetch failed");
    const down = (async () => {
      throw cause;
    }) as unknown as typeof fetch;
    const unreachable = await source(down)
      .get()
      .catch((error: unknown) => error);
    expect(unreachable).toMatchObject({ failure: "unreachable", status: undefined, cause });
  });

  it("refuses to sign with a key that cannot, before any request", async () => {
    const api = google(() => Response.json({ access_token: "t", expires_in: 3600 }));
    const tokens = createGoogleTokenSource({
      key: { ...key, privateKey: "not a key" },
      scope: "s",
      timeoutMs: 1000,
      renewMarginSeconds: 60,
      fetch: api.fetch,
    });
    await expect(tokens.get()).rejects.toMatchObject({ failure: "sign", code: "unknown" });
    expect(api.calls()).toBe(0);
  });

  it("counts a 5xx as Google not answering, and asks again after it instead of keeping the failure", async () => {
    let first = true;
    const api = google(() => {
      const ok = !first;
      first = false;
      return ok
        ? Response.json({ access_token: "t", expires_in: 3600 })
        : Response.json({}, { status: 503 });
    });
    const tokens = source(api.fetch);
    await expect(tokens.get()).rejects.toMatchObject({
      failure: "unreachable",
      status: 503,
      message: "Google could not answer the token request (503 unknown)",
    });
    expect(await tokens.get()).toBe("t");
  });
});
