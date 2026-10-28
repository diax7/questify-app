import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPushProviders } from "#src/push/providers";
import { missingPlatforms } from "#src/push/worker";

const apns = () => ({
  keyId: "ABC123DEFG",
  teamId: "DEF123GHIJ",
  privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
  topic: "app.questify.mobile",
});

const fcm = () => ({
  projectId: "questify-test",
  key: {
    clientEmail: "push@questify-test.iam.gserviceaccount.com",
    privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
    tokenUri: "https://oauth2.googleapis.test/token",
  },
});

describe("createPushProviders", () => {
  it("builds nothing without settings, so both platforms send nothing", () => {
    const providers = createPushProviders({ apns: undefined, fcm: undefined }, () => undefined);
    expect(providers).toEqual([]);
    expect(missingPlatforms(providers)).toEqual(["ios", "android"]);
  });

  it("builds both APNs targets and FCM, and asks for the FCM token at start", async () => {
    let tokenRequests = 0;
    const fetch = (async () => {
      tokenRequests += 1;
      return Response.json({ access_token: "ya29.t", expires_in: 3600 });
    }) as unknown as typeof globalThis.fetch;
    const providers = createPushProviders({ apns: apns(), fcm: fcm() }, () => undefined, { fetch });
    expect(providers.map((provider) => provider.target)).toEqual([
      "apns:production",
      "apns:sandbox",
      "fcm",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tokenRequests).toBe(1);
    await Promise.all(providers.map((provider) => provider.close()));
  });

  it("builds one platform alone", async () => {
    const ios = createPushProviders({ apns: apns(), fcm: undefined }, () => undefined);
    expect(missingPlatforms(ios)).toEqual(["android"]);
    await Promise.all(ios.map((provider) => provider.close()));
  });

  it("stops the start when the APNs key cannot sign", () => {
    const broken = {
      ...apns(),
      privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey,
    };
    expect(() => createPushProviders({ apns: broken, fcm: undefined }, () => undefined)).toThrow(
      "APNS_PRIVATE_KEY could not sign the APNs provider token.",
    );
  });
});
