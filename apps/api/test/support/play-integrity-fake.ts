import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGoogleTokenSource } from "#src/auth/google-token";
import {
  PLAY_INTEGRITY_SCOPE,
  createPlayIntegrity,
  type PlayIntegrity,
} from "#src/integrity/play-integrity";

/**
 * A local stand-in for Google's token endpoint and Play Integrity's `decodeIntegrityToken` (T-812), so the decoder is
 * tested over real HTTP with no network. Each test sets what the next decode answers.
 */

export const TEST_PACKAGE = "app.questify.mobile";

export type DecodeAnswer = Readonly<{ status: number; body: unknown }> | Readonly<{ hang: true }>;

export type PlayFake = Readonly<{
  url: string;
  /** The next answers, in order; the last one repeats. */
  answer: (...answers: readonly DecodeAnswer[]) => void;
  /** Every decode request: its path, bearer token and integrity token. */
  calls: Array<Readonly<{ path: string; bearer: string; token: unknown }>>;
  tokenRequests: () => number;
  close: () => Promise<void>;
}>;

const read = async (request: IncomingMessage): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString("utf8");
};

/** A payload as Google decodes a good token for `challenge`, with `change` merged over its parts. */
export function goodPayload(
  challenge: string,
  change: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  now = Date.now(),
): Record<string, unknown> {
  const parts: Record<string, Record<string, unknown>> = {
    requestDetails: {
      requestPackageName: TEST_PACKAGE,
      nonce: challenge,
      timestampMillis: String(now),
    },
    appIntegrity: {
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      packageName: TEST_PACKAGE,
      certificateSha256Digest: ["abc"],
      versionCode: "42",
    },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
    accountDetails: { appLicensingVerdict: "LICENSED" },
  };
  for (const [name, fields] of Object.entries(change)) parts[name] = { ...parts[name], ...fields };
  return { tokenPayloadExternal: parts };
}

export async function startPlayFake(): Promise<PlayFake> {
  let answers: readonly DecodeAnswer[] = [{ status: 500, body: {} }];
  let tokens = 0;
  const calls: Array<Readonly<{ path: string; bearer: string; token: unknown }>> = [];
  const hanging: Array<() => void> = [];
  const server: Server = createServer((request, response) => {
    void read(request).then((text) => {
      if (request.url === "/token") {
        tokens += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: `access-${tokens}`, expires_in: 3600 }));
        return;
      }
      const parsed = JSON.parse(text) as Record<string, unknown>;
      calls.push({
        path: request.url ?? "",
        bearer: request.headers.authorization ?? "",
        token: parsed["integrity_token"],
      });
      const [next, ...rest] = answers;
      if (rest.length > 0) answers = rest;
      if (next === undefined || "hang" in next) {
        hanging.push(() => response.destroy());
        return;
      }
      response.writeHead(next.status, { "content-type": "application/json" });
      response.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    answer: (...next) => {
      answers = next;
    },
    calls,
    tokenRequests: () => tokens,
    close: async () => {
      for (const end of hanging) end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The real decoder pointed at the fake, with a throwaway service account key. */
export function fakePlayIntegrity(
  fake: PlayFake,
  timeoutMs = 2000,
  now?: () => number,
): PlayIntegrity {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return createPlayIntegrity({
    tokens: createGoogleTokenSource({
      key: { clientEmail: "integrity@questify.test", privateKey, tokenUri: `${fake.url}/token` },
      scope: PLAY_INTEGRITY_SCOPE,
      timeoutMs,
      renewMarginSeconds: 60,
    }),
    packageName: TEST_PACKAGE,
    baseUrl: fake.url,
    timeoutMs,
    ...(now === undefined ? {} : { now }),
  });
}
