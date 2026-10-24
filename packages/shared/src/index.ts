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
export type { PollChoices, PollResults, QuestType, QuestVerification } from "./quests/registry";
export {
  isLivePoll,
  POLL_CHOICES,
  POLL_MINUTES,
  POLL_RESULTS,
  QR_QUEST_TYPES,
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isQuestType,
  MEET_DAILY_CAP,
  normalizeEntryCode,
  parseVerification,
  PASSPORT_STEPS_MAX,
  PLACE_RADIUS,
  PLACED_QUEST_TYPES,
  VENUE_RADIUS,
  QUEST_CODE_HOSTS,
  parseQuestConfig,
  QUIZ_GRACE_SECONDS,
  REFRESHING_QUEST_TYPES,
  SUBMISSION_TEXT_MAX,
  SURVEY_TEXT_MAX,
  GAME_ATTEMPTS,
  GAME_COOLDOWN_MINUTES,
  unavailableSubmissionKind,
} from "./quests/registry";
export { MEET_CODE_PREFIX, meetCodeOf, meetTokenOf } from "./quests/meet-code";
export type { Avatar } from "./players/avatars";
export { AVATARS } from "./players/avatars";
export type { UsernameCheck } from "./players/username";
export { USERNAME_MAX, USERNAME_MIN, checkUsername } from "./players/username";
export type { JoinCard } from "./join/card";
export { joinCard } from "./join/card";
export type { JoinFieldKind } from "./join/fields";
export { JOIN_FIELD_KINDS, joinFieldKindKey, joinFieldLabel } from "./join/fields";
export { JOIN_LINK_HOSTS, joinLink, parseJoinLink } from "./join/link";
export type { JoinOption, JoinOptionInput } from "./join/options";
export {
  JOIN_OPTION_LABEL_MAX,
  JOIN_OPTION_MAX,
  JOIN_OPTION_MIN,
  cleanOptions,
  joinOptionLabel,
} from "./join/options";
export { parseRehearsalCode } from "./join/rehearsal";
export type { OfficialRules, RulesData, RulesPrize } from "./results/rules";
export { officialRules } from "./results/rules";
export type {
  ImpossibleReason,
  Judgement,
  GameEngine,
  RealtimeEngine,
  TimedInput,
} from "./games/engine";
export { HUMAN_FLOOR_MS, canInput, judge, lastInputMs, replay } from "./games/engine";
export type { GameLevel, GameName } from "./games/levels";
export { GAME_LEVELS, GAME_NAMES, LEVELS, isGameLevel, isGameName } from "./games/levels";
export type { GameTarget } from "./games/registry";
export { ENGINE_VERSIONS, gameTarget, hasEngine, judgeRound } from "./games/registry";
export type { MemoryInput, MemoryParams, MemoryResult, MemoryState } from "./games/memory-match/v1";
export { MISMATCH_MS, memoryMatchV1 } from "./games/memory-match/v1";
export type { SlideInput, SlideParams, SlideResult, SlideState } from "./games/slide-puzzle/v1";
export { SLIDE_PICTURES, neighbours, slidePuzzleV1 } from "./games/slide-puzzle/v1";
export { GAME_LEVEL_KEYS, GAME_NAME_KEYS, targetWords } from "./games/words";
export type { CatchInput, CatchItem, CatchParams, CatchResult, CatchState } from "./games/catch/v1";
export { BOARD_UNITS, CATCH_FACES, catchV1 } from "./games/catch/v1";
export type {
  TapRushInput,
  TapRushParams,
  TapRushResult,
  TapRushState,
  TapTarget,
} from "./games/tap-rush/v1";
export { TAP_REACTION_FLOOR_MS, tapRushV1 } from "./games/tap-rush/v1";
export { TICKS_PER_SECOND, endTickOf, tickAt, tickStartMs } from "./games/ticks";
export type { Prng } from "./games/prng";
export { prng } from "./games/prng";
export type { TicketKind } from "./tickets/tickets";
export { TICKET_KINDS, TICKET_OPEN_LIMIT, TICKET_TEXT_MAX } from "./tickets/tickets";
