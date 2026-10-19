export type { ApiErrorEnvelope, LocalizedText } from "./errors";
export { apiError } from "./errors";
export { compareVersions, isBelowMinimum } from "./app-version";
export type { CursorPosition } from "./pagination";
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  parseLimit,
} from "./pagination";
export type { ComposedConfig, ComposedFeature } from "./config/compose";
export { composeConfig } from "./config/compose";
export type {
  EventConfig,
  FeatureDefinition,
  FeatureRegistry,
  PlatformFeatureSetting,
  PlatformSettings,
  Registries,
  TuningDefinition,
  TuningRegistry,
} from "./config/registry";
export { FEATURES, REGISTRIES, TUNING } from "./config/registry";
export { readEventSwitches, readPlatformSettings } from "./config/read";
export type { ConfigIssue, Validation } from "./config/validate";
export {
  isGatedFeature,
  parseComposedConfig,
  validateEventConfig,
  validatePlatformSettings,
} from "./config/validate";
export type { RateLimitState } from "./rate-limit";
export { rateLimitHeaders } from "./rate-limit";
