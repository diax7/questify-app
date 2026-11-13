import { X509Certificate } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createGoogleTokenSource } from "#src/auth/google-token";
import type { AuthKeys } from "#src/auth/keys";
import type { IntegritySettings } from "#src/config";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import {
  APPLE_APP_ATTEST_ROOT,
  clientDataHashOf,
  verifyAssertion,
  verifyAttestation,
  type AppAttestSettings,
} from "#src/integrity/app-attest";
import { challengeHolds, makeChallenge, type Holder } from "#src/integrity/challenge";
import {
  PLAY_INTEGRITY_SCOPE,
  createPlayIntegrity,
  type PlayIntegrity,
} from "#src/integrity/play-integrity";

/**
 * The device-integrity check (T-812, FR-334, ADR-833): a challenge, then the platform's proof, verified here and
 * recorded per install by `record_device_check`, which flags a failed install's accounts. Never blocking: no outcome
 * refuses anything, and the player is never told the verdict (ADR-154).
 */

export type Platform = "ios" | "android";

/** The verifiers built from the settings; a platform without one is off. */
export type IntegrityVerifiers = Readonly<{
  play: PlayIntegrity | undefined;
  appAttest: AppAttestSettings | undefined;
}>;

export type IntegrityDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "integrityChallengeTag">;
  verifiers: IntegrityVerifiers;
  /** Milliseconds since 1970; replaced in tests. */
  now?: () => number;
}>;

export type CheckBody =
  | Readonly<{ platform: "android"; challenge: string; token: string }>
  | Readonly<{ platform: "ios"; challenge: string; keyId: string; attestation: string }>
  | Readonly<{ platform: "ios"; challenge: string; keyId: string; assertion: string }>;

/**
 * What the app does next: `done` (whatever the verdict), `attest` (the key is unknown here: attest a new one), or
 * `later` (no verdict now: Google did not answer, or the challenge was stale or not this install's).
 */
export type Next = "done" | "attest" | "later";

/** What the log line may say: the platform, what happened, and reason codes. Never an id, a token or a key. */
export type CheckLog = Readonly<{
  platform: Platform;
  outcome: string;
  reasons?: readonly string[];
}>;

export type CheckResult = Readonly<{ next: Next; log: CheckLog }>;

/** The timeout of each call to Google (token and decode); one retry each when Google does not answer. */
const GOOGLE_TIMEOUT_MS = 4000;

/** Builds the verifiers from the settings (none without keys). */
export function integrityVerifiers(settings: IntegritySettings): IntegrityVerifiers {
  const play =
    settings.play === undefined
      ? undefined
      : createPlayIntegrity({
          tokens: createGoogleTokenSource({
            key: settings.play.key,
            scope: PLAY_INTEGRITY_SCOPE,
            timeoutMs: GOOGLE_TIMEOUT_MS,
            renewMarginSeconds: 300,
          }),
          packageName: settings.play.packageName,
          timeoutMs: GOOGLE_TIMEOUT_MS,
        });
  const appAttest =
    settings.appAttest === undefined
      ? undefined
      : { ...settings.appAttest, root: new X509Certificate(APPLE_APP_ATTEST_ROOT) };
  return { play, appAttest };
}

const enabled = (verifiers: IntegrityVerifiers, platform: Platform): boolean =>
  platform === "android" ? verifiers.play !== undefined : verifiers.appAttest !== undefined;

/** A challenge for the caller's install, or `enabled: false` when the platform is not set up. */
export function challengeFor(
  deps: IntegrityDeps,
  holder: Holder,
  platform: Platform,
):
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; challenge: string; expiresAt: string }> {
  if (!enabled(deps.verifiers, platform)) {
    return { enabled: false };
  }
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  const made = makeChallenge(deps.keys.integrityChallengeTag, holder, now);
  return {
    enabled: true,
    challenge: made.challenge,
    expiresAt: new Date(made.expiresAt * 1000).toISOString(),
  };
}

type Verdict = Readonly<{ passed: boolean; reasons: readonly string[] }>;

const record = (client: PoolClient, holder: Holder, platform: Platform, verdict: Verdict) =>
  client.query("SELECT record_device_check($1, $2, $3, $4)", [
    holder.installId,
    platform,
    verdict.passed,
    verdict.reasons,
  ]);

/** Runs `work` on the calling player's seat in one transaction. */
const asPlayer = <T>(
  deps: IntegrityDeps,
  holder: Holder,
  work: (client: PoolClient) => Promise<T>,
) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId: holder.playerId }, () => work(client)),
  );

const logged = (platform: Platform, verdict: Verdict): CheckLog => ({
  platform,
  outcome: verdict.passed ? "passed" : "failed",
  reasons: verdict.reasons,
});

async function checkAndroid(
  deps: IntegrityDeps,
  play: PlayIntegrity,
  holder: Holder,
  body: Readonly<{ challenge: string; token: string }>,
): Promise<CheckResult> {
  const verdict = await play.decide(body.token, body.challenge);
  if (verdict.kind === "unavailable") {
    return {
      next: "later",
      log: { platform: "android", outcome: "unavailable", reasons: [verdict.why] },
    };
  }
  await asPlayer(deps, holder, (client) => record(client, holder, "android", verdict));
  return { next: "done", log: logged("android", verdict) };
}

async function attest(
  deps: IntegrityDeps,
  settings: AppAttestSettings,
  holder: Holder,
  input: Readonly<{ keyId: Buffer; attestation: Buffer; clientDataHash: Buffer }>,
): Promise<CheckResult> {
  const attested = verifyAttestation(input, settings, new Date((deps.now ?? Date.now)()));
  const verdict: Verdict = attested.ok
    ? { passed: true, reasons: [] }
    : { passed: false, reasons: [attested.reason] };
  await asPlayer(deps, holder, async (client) => {
    if (attested.ok) {
      await client.query("SELECT app_attest_key_add($1, $2, $3, $4)", [
        input.keyId,
        holder.installId,
        attested.publicKey,
        attested.development,
      ]);
    }
    await record(client, holder, "ios", verdict);
  });
  return { next: "done", log: logged("ios", verdict) };
}

async function assert(
  deps: IntegrityDeps,
  settings: AppAttestSettings,
  holder: Holder,
  input: Readonly<{ keyId: Buffer; assertion: Buffer; clientDataHash: Buffer }>,
): Promise<CheckResult> {
  return asPlayer(deps, holder, async (client) => {
    const { rows } = await client.query<{ public_key: Buffer; sign_count: string }>(
      "SELECT public_key, sign_count FROM app_attest_key_for($1, $2)",
      [input.keyId, holder.installId],
    );
    const stored = rows[0];
    if (stored === undefined) {
      return { next: "attest", log: { platform: "ios", outcome: "unknown_key" } } as const;
    }
    const asserted = verifyAssertion(
      { ...input, publicKey: stored.public_key, storedCounter: Number(stored.sign_count) },
      settings,
    );
    if (asserted.ok && asserted.repeat)
      return { next: "done", log: { platform: "ios", outcome: "repeat" } } as const;
    const verdict: Verdict = asserted.ok
      ? { passed: true, reasons: [] }
      : { passed: false, reasons: [asserted.reason] };
    if (asserted.ok) {
      await client.query("SELECT app_attest_key_count($1, $2, $3)", [
        input.keyId,
        holder.installId,
        asserted.counter,
      ]);
    }
    await record(client, holder, "ios", verdict);
    return { next: "done", log: logged("ios", verdict) } as const;
  });
}

/** The key id and proof as bytes: the key id must be 32 bytes, the proof at most 16 KiB. */
function bytesOf(
  keyId: string,
  proof: string,
): Readonly<{ keyId: Buffer; proof: Buffer }> | undefined {
  const key = Buffer.from(keyId, "base64");
  const bytes = Buffer.from(proof, "base64");
  return key.length === 32 && bytes.length > 0 && bytes.length <= 16_384
    ? { keyId: key, proof: bytes }
    : undefined;
}

async function checkIos(
  deps: IntegrityDeps,
  settings: AppAttestSettings,
  holder: Holder,
  body: Extract<CheckBody, { platform: "ios" }>,
): Promise<CheckResult> {
  const parts = bytesOf(body.keyId, "attestation" in body ? body.attestation : body.assertion);
  if (parts === undefined) {
    const verdict: Verdict = { passed: false, reasons: ["format"] };
    await asPlayer(deps, holder, (client) => record(client, holder, "ios", verdict));
    return { next: "done", log: logged("ios", verdict) } as const;
  }
  const clientDataHash = clientDataHashOf(body.challenge);
  return "attestation" in body
    ? attest(deps, settings, holder, {
        keyId: parts.keyId,
        attestation: parts.proof,
        clientDataHash,
      })
    : assert(deps, settings, holder, {
        keyId: parts.keyId,
        assertion: parts.proof,
        clientDataHash,
      });
}

/** Verifies the proof in `body` for the caller's install and records the verdict. */
export async function checkDevice(
  deps: IntegrityDeps,
  holder: Holder,
  body: CheckBody,
): Promise<CheckResult> {
  const off: CheckResult = { next: "done", log: { platform: body.platform, outcome: "off" } };
  const stale: CheckResult = {
    next: "later",
    log: { platform: body.platform, outcome: "challenge" },
  };
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  const fresh = challengeHolds(deps.keys.integrityChallengeTag, holder, body.challenge, now);
  const { play, appAttest } = deps.verifiers;
  if (body.platform === "android") {
    if (play === undefined) return off;
    return fresh ? checkAndroid(deps, play, holder, body) : stale;
  }
  if (appAttest === undefined) return off;
  return fresh ? checkIos(deps, appAttest, holder, body) : stale;
}
