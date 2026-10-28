import type { PushSettings } from "#src/config";
import { APNS_TARGETS, createApnsProvider, createApnsToken } from "#src/push/apns";
import { createFcmProvider } from "#src/push/fcm";
import type { PushProvider } from "#src/push/provider";
import type { PushLog } from "#src/push/round";

export type ProviderOptions = Readonly<{
  /** Replaces the FCM token request's network call in tests. */
  fetch?: typeof fetch;
}>;

/**
 * The providers the settings allow, built at start (ADR-344 (3) and (4)): both APNs targets on one provider token,
 * signed here so a key that cannot sign stops the server; FCM, whose first access token is asked for in the background
 * (a refusal holds it and logs `push.fcm_auth_failed`). A platform with no settings gets no provider and sends nothing;
 * the worker logs `push.provider_missing` for it in production.
 *
 * @throws Error naming `APNS_PRIVATE_KEY` when the APNs key cannot sign.
 */
export function createPushProviders(
  settings: PushSettings,
  log: PushLog,
  options: ProviderOptions = {},
): PushProvider[] {
  const providers: PushProvider[] = [];
  const { apns, fcm } = settings;
  if (apns !== undefined) {
    const token = createApnsToken(apns);
    for (const target of APNS_TARGETS) {
      providers.push(createApnsProvider({ target, token, topic: apns.topic, log }));
    }
  }
  if (fcm !== undefined) {
    providers.push(
      createFcmProvider({
        settings: fcm,
        log,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    );
  }
  return providers;
}
