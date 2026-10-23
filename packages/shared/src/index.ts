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
export { readEventSwitches, readPlatformSettings, readStoredTerms } from "./config/read";
export type { CurrencyIcon, EventTerms, EventTermsInput, Word, WordForms } from "./config/terms";
export {
  CURRENCY_ICONS,
  DEFAULT_TERMS,
  TERM_MAX,
  readEventTerms,
  termFor,
  validateEventTerms,
} from "./config/terms";
export type { ConfigIssue, Validation } from "./config/validate";
export {
  isGatedFeature,
  parseComposedConfig,
  validateEventConfig,
  validatePlatformSettings,
} from "./config/validate";
export type { RateLimitState } from "./rate-limit";
export { rateLimitHeaders } from "./rate-limit";
export type {
  ColorRole,
  FontRole,
  FontWeight,
  RadiusStep,
  SpacingStep,
  TextStyle,
  TextVariant,
  Theme,
} from "./design/theme";
export { adventurePalette, adventureTheme } from "./design/adventure";
export type { ThemeId } from "./design/themes";
export { DEFAULT_THEME, THEMES } from "./design/themes";
export type { Language } from "./i18n/digits";
export { formatNumber, toWesternDigits } from "./i18n/digits";
export type { MessageKey, Messages } from "./i18n/messages";
export { MESSAGES } from "./i18n/messages";
export { interpolate, placeholdersOf } from "./i18n/placeholders";
export type { Overrides } from "./i18n/translate";
export {
  NO_OVERRIDES,
  createTranslator,
  isUsableOverride,
  validateTranslation,
} from "./i18n/translate";
export type {
  Acceptance,
  OrganizerDocument,
  OrganizerDocumentId,
  PlayerDocument,
  PlayerDocumentId,
  SignupAcceptance,
} from "./legal/documents";
export {
  missingAcceptances,
  missingSignupAcceptances,
  organizerDocuments,
  playerDocuments,
  signupDocuments,
} from "./legal/documents";
export {
  eventDayOf,
  formatEventTime,
  formatTimeWindow,
  isTimeZone,
  localParts,
  toInstant,
  toLocalInput,
  zoneLabel,
} from "./time/event-time";
export type { QuestType, QuestVerification } from "./quests/registry";
export {
  QR_QUEST_TYPES,
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isQuestType,
  normalizeEntryCode,
  parseVerification,
  QUEST_CODE_HOSTS,
  parseQuestConfig,
} from "./quests/registry";
export type { Avatar } from "./players/avatars";
export { AVATARS } from "./players/avatars";
export type { UsernameCheck } from "./players/username";
export { USERNAME_MAX, USERNAME_MIN, checkUsername } from "./players/username";
export type { JoinCard } from "./join/card";
export { joinCard } from "./join/card";
export type { JoinFieldKind } from "./join/fields";
export { JOIN_FIELD_KINDS, joinFieldKindKey, joinFieldLabel } from "./join/fields";
export { JOIN_LINK_HOSTS, joinLink, parseJoinLink } from "./join/link";
export { parseRehearsalCode } from "./join/rehearsal";
export type { OfficialRules, RulesData, RulesPrize } from "./results/rules";
export { officialRules } from "./results/rules";
