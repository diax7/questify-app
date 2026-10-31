import { MESSAGES } from "@questify/shared";
import { HttpError } from "#src/http-error";

type Details = Readonly<Record<string, unknown>>;

const make =
  (status: number, code: string, ar: string, en: string) =>
  (details: Details = {}): HttpError =>
    new HttpError(status, code, { ar, en }, details);

export const invalidCredentials = make(
  401,
  "invalid_credentials",
  "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  "The email or password is not correct.",
);
export const invalidCode = make(
  401,
  "invalid_code",
  "الرمز غير صحيح.",
  "That code is not correct.",
);
export const unauthenticated = make(
  401,
  "unauthenticated",
  "يلزم تسجيل الدخول.",
  "Sign in to continue.",
);
export const sessionExpired = make(
  401,
  "session_expired",
  "انتهت جلستك. سجّل الدخول من جديد.",
  "Your session has ended. Sign in again.",
);
export const csrfRejected = make(
  403,
  "csrf_rejected",
  "الطلب مرفوض.",
  "This request was rejected.",
);
export const challengeExpired = make(
  410,
  "challenge_expired",
  "انتهت صلاحية الرمز. ابدأ تسجيل الدخول من جديد.",
  "That code has expired. Start signing in again.",
);
export const tooManyAttempts = make(
  429,
  "too_many_attempts",
  "محاولات كثيرة. حاول مرة أخرى لاحقا.",
  "Too many attempts. Try again later.",
);
export const tooManyChallenges = make(
  429,
  "too_many_challenges",
  "طلبات كثيرة لرموز الدخول. حاول مرة أخرى لاحقا.",
  "Too many sign-in codes were requested. Try again later.",
);
export const resendTooSoon = make(
  429,
  "resend_too_soon",
  "انتظر قليلا قبل طلب رمز جديد.",
  "Wait a moment before asking for a new code.",
);
export const resendLimit = make(
  429,
  "resend_limit",
  "وصلت إلى الحد الأقصى لإعادة الإرسال. ابدأ من جديد.",
  "You have used all resends. Start signing in again.",
);
export const busy = make(
  503,
  "busy",
  "الخدمة مشغولة. حاول بعد لحظات.",
  "The service is busy. Try again in a moment.",
);
export const emailUnavailable = make(
  503,
  "email_unavailable",
  "تعذر إرسال الرمز. حاول مرة أخرى بعد قليل.",
  "We could not send the code. Try again shortly.",
);
export const invalidRequest = make(
  400,
  "invalid_request",
  "الطلب غير صالح.",
  "The request is not valid.",
);
export const notFound = make(404, "not_found", "غير موجود.", "Not found.");
export const weakPassword = make(
  422,
  "weak_password",
  "اختر كلمة مرور أقوى.",
  "Choose a stronger password.",
);
export const resetLinkInvalid = make(
  410,
  "reset_link_invalid",
  "انتهت صلاحية الرابط أو استُخدم من قبل. اطلب رابطا جديدا.",
  "This link has expired or was already used. Ask for a new one.",
);
export const currentPasswordWrong = make(
  403,
  "current_password_wrong",
  "كلمة المرور الحالية غير صحيحة.",
  "Your current password is not correct.",
);
export const breachCheckUnavailable = make(
  503,
  "breach_check_unavailable",
  "تعذر فحص كلمة المرور الآن. حاول بعد قليل.",
  "We could not check the password right now. Try again shortly.",
);
export const ownerOnly = make(
  403,
  "owner_only",
  "هذا الإجراء لمالك الجهة المنظِّمة فقط.",
  "Only the organizer's owner can do this.",
);
export const acceptanceRequired = make(
  422,
  "acceptance_required",
  "وافق على شروط المنظِّمين واتفاقية معالجة البيانات وقواعد المحتوى للمتابعة.",
  "Accept the organizer terms, the data processing agreement and the content rules to continue.",
);
export const invalidOrganizerName = make(
  422,
  "invalid_organizer_name",
  "اكتب اسم الجهة المنظِّمة كما يعرفه الناس، دون روابط أو عناوين بريد.",
  "Write the organizer's name as people know it, without links or email addresses.",
);
export const ownerRequired = make(
  409,
  "owner_required",
  "لكل جهة منظِّمة مالك واحد. انقل الملكية أولًا.",
  "An organizer always has one owner. Transfer ownership first.",
);
export const alreadyMember = make(
  409,
  "already_member",
  "هذا الشخص عضو في الفريق من قبل.",
  "This person is already on the team.",
);
export const inviteInvalid = make(
  410,
  "invite_invalid",
  "انتهت صلاحية الدعوة أو استُخدمت من قبل. اطلب دعوة جديدة.",
  "This invite has expired or was already used. Ask for a new one.",
);
export const inviteOtherAccount = make(
  403,
  "invite_other_account",
  "أُرسلت هذه الدعوة إلى بريد آخر. سجّل الدخول بالحساب الذي وصلته الدعوة.",
  "This invite was sent to another email. Sign in with the account it was sent to.",
);
export const signInToAccept = make(
  409,
  "sign_in_to_accept",
  "لهذا البريد حساب. سجّل الدخول ثم اقبل الدعوة.",
  "This email has an account. Sign in, then accept the invite.",
);
export const mailCap = make(
  429,
  "mail_cap",
  "وصلنا إلى حد الرسائل لهذا اليوم. حاول غدًا.",
  "We have reached today's email limit. Try again tomorrow.",
);
export const invalidScope = make(
  422,
  "invalid_scope",
  "اختر فعالية واحدة على الأقل من فعاليات هذه الجهة.",
  "Choose at least one of this organizer's events.",
);
export const inviteSelf = make(
  422,
  "invite_self",
  "لا يمكنك دعوة نفسك.",
  "You cannot invite yourself.",
);
export const invitesPendingFull = make(
  409,
  "invites_pending_full",
  "لديك 20 دعوة بانتظار القبول. ألغِ دعوة قبل إرسال أخرى.",
  "You have 20 invites waiting. Cancel one before sending another.",
);
export const invalidEvent = make(
  422,
  "invalid_event",
  "راجع بيانات الفعالية: الحقل المحدد غير صالح.",
  "Check the event's details: the named field is not valid.",
);
export const invalidTerms = make(
  422,
  "invalid_terms",
  "راجع كلمات الفعالية: الحقل المحدد غير صالح.",
  "Check the event's words: the named field is not valid.",
);
export const invalidBranding = make(
  422,
  "invalid_branding",
  "اختر لونًا من القائمة.",
  "Pick a colour from the list.",
);
export const eventArchived = make(
  409,
  "event_archived",
  "الفعالية مؤرشفة، فلا يمكن تعديلها.",
  "The event is archived, so it cannot change.",
);
export const eventTimesLocked = make(
  409,
  "event_times_locked",
  "لا يمكن تغيير هذه الأوقات الآن: بدأت الفعالية أو انتهت.",
  "These times can no longer change: the event has started or ended.",
);
export const eventCityLocked = make(
  409,
  "city_locked",
  "لا يمكن تغيير مدينة الفعالية بعد أن تبدأ.",
  "The event's city can no longer change: the event has started.",
);
export const invalidQuestify = make(
  422,
  "invalid_questify",
  "راجع بيانات المهمة أو الموسم: الحقل المحدد غير صالح.",
  "Check the quest or campaign details: the named field is not valid.",
);
export const questifyConflict = make(
  409,
  "questify_conflict",
  "لا يمكن إجراء هذا التغيير الآن. راجع حالة المهمة أو الموسم.",
  "This change is not possible now. Check the quest or campaign's status.",
);
export const invalidPreferences = make(
  422,
  "invalid_preferences",
  "راجع المدينة أو الاهتمامات: الحقل المحدد غير صالح.",
  "Check the city or interests: the named field is not valid.",
);
export const invalidPushDevice = make(
  422,
  "invalid_push_device",
  "تعذّر تسجيل الجهاز: الحقل المحدد غير صالح.",
  "Couldn't register the device: the named field is not valid.",
);
export const consentTextOutdated = make(
  409,
  "consent_text_outdated",
  "تغيّر نص الموافقة. حدّث التطبيق ثم أعد المحاولة.",
  "The consent wording has changed. Update the app and try again.",
);
export const consentAge = make(
  403,
  "consent_age",
  "لا يمكن تفعيل الرسائل الترويجية لهذا الحساب.",
  "Promotional messages cannot be turned on for this account.",
);
export const invalidOptOut = make(
  400,
  "invalid_opt_out",
  "رابط إلغاء الاشتراك غير صالح.",
  "This opt-out link is not valid.",
);
export const gemItemNotFound = make(
  404,
  "gem_item_not_found",
  "هذا العنصر غير متاح في متجر الجواهر.",
  "This item isn't in the gem shop.",
);
export const gemShopConflict = make(
  409,
  "gem_shop_conflict",
  "تعذّر الحصول على هذا العنصر الآن. حدّث المتجر وحاول مرة أخرى.",
  "You can't get this item right now. Refresh the shop and try again.",
);
/** One answer for a malformed key: the conventions' format check and a door that needs a UUID key (the gem shop). */
export const idempotencyKeyInvalid = make(
  400,
  "idempotency_key_invalid",
  "مفتاح Idempotency-Key غير صالح.",
  "The Idempotency-Key is not valid for this action.",
);
export const eventNotDraft = make(
  409,
  "event_not_draft",
  "يمكن حذف المسودات فقط. الفعالية المفعّلة تبقى في السجل.",
  "Only drafts can be deleted. An activated event stays on record.",
);
export const eventNotLive = make(
  409,
  "event_not_live",
  "يمكن إنهاء الفعالية مبكرًا أثناء سيرها فقط.",
  "Only a live event can be ended early.",
);
export const scopeLimited = make(
  403,
  "scope_limited",
  "أنت محدود بفعاليات مختارة، فلا يمكنك إنشاء فعالية جديدة.",
  "You are limited to chosen events, so you cannot create a new one.",
);
export const confirmRequired = make(
  409,
  "confirm_required",
  "الفعالية جارية: يرى اللاعبون هذا التغيير فورًا. أكّد للمتابعة.",
  "The event is live: players see this change at once. Confirm to go ahead.",
);
export const eventClosed = make(
  409,
  "event_closed",
  "انتهت الفعالية، فمهامها وفئاتها ثابتة.",
  "The event has ended, so its quests and categories are fixed.",
);
export const invalidQuest = make(
  422,
  "invalid_quest",
  "راجع بيانات المهمة: الحقل المحدد غير صالح.",
  "Check the quest's details: the named field is not valid.",
);
export const invalidCategory = make(
  422,
  "invalid_category",
  "راجع بيانات الفئة: الحقل المحدد غير صالح.",
  "Check the category's details: the named field is not valid.",
);
export const limitReached = make(
  409,
  "limit_reached",
  "وصلت إلى الحد الأقصى لهذه الفعالية.",
  "This event has reached its limit.",
);
export const orderStale = make(
  409,
  "order_stale",
  "تغيّر الترتيب أثناء عملك. أعد التحميل وحاول مرة أخرى.",
  "The order changed while you worked. Reload and try again.",
);
export const lastCategory = make(
  409,
  "last_category",
  "تحتاج الفعالية إلى فئة واحدة على الأقل.",
  "An event needs at least one category.",
);
export const categoryInUse = make(
  409,
  "category_in_use",
  "تُفتح فئات أخرى بعد إكمال هذه الفئة. غيّر ذلك فيها أولًا.",
  "Other categories unlock after this one. Change them first.",
);
export const categoryNotEmpty = make(
  409,
  "category_not_empty",
  "في هذه الفئة مهام. اختر نقلها إلى فئة أخرى أو حذفها.",
  "This category holds quests. Choose to move them to another category or delete them.",
);
export const questNotOpen = make(
  403,
  "quest_not_open",
  "هذه المهمة غير متاحة الآن.",
  "This quest is not open right now.",
);
export const enrollmentInactive = make(
  403,
  "enrollment_inactive",
  "لا يمكنك المشاركة في هذه الفعالية الآن.",
  "You cannot take part in this event right now.",
);
export const alreadyCompleted = make(
  409,
  "already_completed",
  "أكملت هذه المهمة من قبل.",
  "You already completed this quest.",
);
export const questCodeInvalid = make(
  422,
  "invalid_code",
  "هذا الرمز لا يعمل لهذه المهمة.",
  "This code does not work for this quest.",
);
export const idempotencyKeyReused = make(
  422,
  "idempotency_key_reused",
  "تم استخدام هذا المفتاح مع طلب مختلف.",
  "This key was already used with a different request.",
);
export const hasCompletions = make(
  409,
  "has_completions",
  "أكمل لاعبون هذه المهمة، فنقاطهم محفوظة. أخفِها بدلًا من حذفها.",
  "Players completed this quest, so their points stay. Hide it instead of deleting it.",
);
export const stepInUse = make(
  409,
  "step_in_use",
  "ختم لاعبون هذه الخطوة، فلا يمكن حذفها. غيّر اسمها بدلًا من ذلك.",
  "Players stamped this step, so it can't be deleted. Rename it instead.",
);
export const phoneNotSupported = make(
  422,
  "phone_not_supported",
  "نرسل الرمز إلى أرقام الجوال السعودية فقط. استخدم بريدك الإلكتروني بدلًا منه.",
  "Codes go to Saudi mobile numbers only. Use your email instead.",
);
export const smsUnavailable = make(
  503,
  "sms_unavailable",
  "تعذّر إرسال الرسالة الآن. استخدم بريدك الإلكتروني بدلًا منها.",
  "We could not send the text right now. Use your email instead.",
);
export const accountBanned = make(
  403,
  "account_banned",
  "حسابك موقوف. تواصل مع فريق Questify إن كنت ترى أنه خطأ.",
  "Your account is suspended. Contact the Questify team if you think this is a mistake.",
);
export const signupExpired = make(
  410,
  "signup_expired",
  "انتهت مهلة إنشاء الحساب. اطلب رمزًا جديدًا.",
  "The time to create your account ran out. Ask for a new code.",
);
export const tooYoung = make(
  422,
  "too_young",
  "يجب أن يكون عمرك 13 سنة أو أكثر لإنشاء حساب.",
  "You need to be 13 or older to create an account.",
);
export const invalidBirthYear = make(
  422,
  "invalid_birth_year",
  "أدخل سنة ميلاد صحيحة.",
  "Enter a valid birth year.",
);
export const invalidUsername = make(
  422,
  "invalid_username",
  "اختر اسم مستخدم من 3 إلى 30 حرفًا أو رقمًا أو _ بالعربية أو الإنجليزية.",
  "Choose a username of 3 to 30 letters, digits or _, in Arabic or English.",
);
export const usernameTaken = make(
  409,
  "username_taken",
  "اسم المستخدم هذا محجوز. جرّب اسمًا آخر.",
  "That username is taken. Try another.",
);
export const contactTaken = make(
  409,
  "contact_taken",
  "لهذا الرقم أو البريد حساب الآن. سجّل الدخول من جديد.",
  "This number or email has an account now. Sign in again.",
);
export const notEnrolled = make(
  403,
  "not_enrolled",
  "انضم إلى الفعالية لتشارك فيها.",
  "Join the event to take part.",
);
export const rankingOff = make(
  404,
  "ranking_off",
  "الترتيب مخفي في هذه الفعالية.",
  "The ranking is hidden for this event.",
);
/** The Questify-wide ranking while its platform switch is off (T-408, ADR-322). */
export const questifyRankingOff = make(
  404,
  "ranking_off",
  "ترتيب Questify غير متاح الآن.",
  "The Questify ranking is not available right now.",
);
export const todayRankingOff = make(
  404,
  "today_ranking_off",
  "لا يوجد ترتيب اليوم في هذه الفعالية الآن.",
  "This event has no today's ranking right now.",
);
export const usernameBlocked = make(
  422,
  "username_blocked",
  "لا يمكن استخدام اسم المستخدم هذا. اختر اسمًا آخر.",
  "That username can't be used. Choose another.",
);
export const usernameChangesOff = make(
  403,
  "username_changes_off",
  "تغيير اسم المستخدم متوقف حاليًا.",
  "Username changes are paused for now.",
);
export const usernameTooSoon = make(
  429,
  "username_too_soon",
  "غيّرت اسم المستخدم مؤخرًا. يمكنك تغييره مرة أخرى لاحقًا.",
  "You changed your username recently. You can change it again later.",
);
export const playerAcceptanceRequired = make(
  422,
  "acceptance_required",
  "وافق على شروط الاستخدام وسياسة الخصوصية للمتابعة.",
  "Accept the terms of use and the privacy policy to continue.",
);
export const eventEnded = make(
  409,
  "event_ended",
  "انتهت هذه الفعالية، فلا يمكن الانضمام إليها.",
  "This event has ended, so it cannot be joined.",
);
export const joinMethodOff = make(
  403,
  "join_method_off",
  "لا تقبل هذه الفعالية الانضمام بهذه الطريقة. اسأل منظّمها.",
  "This event does not take joins this way. Ask its organizer.",
);
export const joinNotAllowed = make(
  403,
  "join_not_allowed",
  "لا يمكنك الانضمام إلى هذه الفعالية.",
  "You cannot join this event.",
);
export const joinCardStale = make(
  422,
  "card_version_stale",
  "تغيّرت بطاقة الانضمام. راجعها ثم انضم.",
  "The join card has changed. Read it again, then join.",
);
export const membershipPending = make(
  403,
  "membership_pending",
  "طلب انضمامك بانتظار موافقة المنظّم.",
  "Your request to join is waiting for the organizer's approval.",
);
export const membersOnly = make(
  403,
  "members_only",
  "مهام هذه الفعالية لأعضائها فقط.",
  "This event's quests are for its members only.",
);
export const banNotAllowed = make(
  409,
  "ban_not_allowed",
  "هذا اللاعب ليس في الفعالية الآن: أُزيل أو غادر أو ينتظر قبول طلبه، فلا يمكن حظره أو رفع الحظر عنه.",
  "This player is not in the event now (removed, left, or waiting on a join request), so they cannot be banned or unbanned.",
);
export const invalidExclusion = make(
  422,
  "invalid_exclusion",
  "أدخل رقم جوال سعوديًا أو نطاق بريد مثل company.com.",
  "Enter a Saudi mobile number or an email domain such as company.com.",
);
export const exclusionListFull = make(
  409,
  "exclusion_list_full",
  "قائمة الاستبعاد ممتلئة (500 إدخال). احذف إدخالًا ثم أضف غيره.",
  "The exclusion list is full (500 entries). Remove one, then add another.",
);
export const cannotLeave = make(
  409,
  "cannot_leave",
  "لا يمكنك مغادرة هذه الفعالية.",
  "You cannot leave this event.",
);
export const contactCodeWrong = make(
  422,
  "invalid_code",
  "الرمز غير صحيح.",
  "That code is not correct.",
);
export const contactInUse = make(
  409,
  "contact_in_use",
  "هذا الرقم أو البريد مرتبط بحساب آخر، فلا يمكن إضافته إلى حسابك.",
  "This number or email belongs to another account, so it cannot be added to yours.",
);
export const contactUnchanged = make(
  409,
  "contact_unchanged",
  "هذا الرقم أو البريد مرتبط بحسابك بالفعل.",
  "This number or email is already on your account.",
);
export const invalidReward = make(
  422,
  "invalid_reward",
  "راجع بيانات الجائزة: الحقل المحدد غير صالح.",
  "Check the reward's details: the named field is not valid.",
);
export const stockFromCodes = make(
  409,
  "stock_from_codes",
  "كمية الجائزة الرقمية هي عدد رموزها، فأضف رموزًا لزيادتها.",
  "A digital reward's stock is its codes: add codes to raise it.",
);
export const notDigital = make(
  409,
  "not_digital",
  "تُضاف الرموز إلى الجوائز الرقمية فقط.",
  "Codes can be added to digital rewards only.",
);
export const tooManyCodes = make(
  422,
  "too_many_codes",
  "تتجاوز هذه الرموز الحد الأعلى للجائزة (100000 رمز).",
  "These codes would take the reward over its limit of 100000 codes.",
);
export const settingLocked = make(
  409,
  "setting_locked",
  "لا يمكن تغيير هذا الإعداد بعد بدء الفعالية.",
  "This setting cannot change once the event has started.",
);
export const stockBelowReserved = make(
  409,
  "stock_below_reserved",
  "لا يمكن أن تقل الكمية عن المحجوز منها والمُسلَّم.",
  "The stock cannot be lower than the units already reserved or handed over.",
);
export const shopClosed = make(
  403,
  "shop_closed",
  "متجر الجوائز مغلق الآن.",
  "The rewards shop is closed right now.",
);
/** The days after the end cannot change this way (T-410, ADR-336): `reason` closed or shorter. */
export const shopWindowLocked = make(
  409,
  "shop_window_locked",
  "بعد نهاية الفعالية يمكن زيادة أيام بقاء المتجر فقط، ولا يمكن تغييرها بعد إغلاقه.",
  "After the event ends, the shop can only stay open longer, and its days can't change once it has closed.",
);
export const rewardNotOpen = make(
  403,
  "reward_not_open",
  "هذه الجائزة غير متاحة الآن.",
  "This reward is not available right now.",
);
export const soldOut = make(409, "sold_out", "نفدت هذه الجائزة.", "This reward is sold out.");
export const rewardLimitReached = make(
  409,
  "reward_limit_reached",
  "وصلت إلى الحد المسموح من هذه الجائزة.",
  "You have reached the limit for this reward.",
);
export const notEnoughBalance = make(
  422,
  "not_enough_balance",
  "رصيدك لا يكفي لهذه الجائزة.",
  "Your balance is not enough for this reward.",
);
export const reservationEnded = make(
  409,
  "reservation_ended",
  "انتهى هذا الحجز، فلا يمكن إلغاؤه.",
  "This reservation has ended, so it cannot be cancelled.",
);
export const inviteNotFound = make(
  404,
  "invite_not_found",
  "رمز المشغّل هذا غير صالح أو أُلغي.",
  "This operator code is not valid or was cancelled.",
);
export const inviteUsed = make(
  409,
  "invite_used",
  "استُخدم رمز المشغّل هذا من قبل.",
  "This operator code has already been used.",
);
export const inviteExpired = make(
  409,
  "invite_expired",
  "انتهت صلاحية رمز المشغّل هذا.",
  "This operator code has expired.",
);
export const inviteEmailMismatch = make(
  403,
  "invite_email_mismatch",
  "هذه الدعوة لبريد إلكتروني آخر. سجّل الدخول بالبريد الذي وصلته الدعوة، أو أضفه إلى حسابك.",
  "This invite is for another email. Sign in with the email that received it, or add it to your account.",
);
export const alreadyOperator = make(
  409,
  "already_operator",
  "أنت مشغّل في هذه الفعالية بالفعل.",
  "You are already an operator at this event.",
);
export const notOperator = make(
  403,
  "not_operator",
  "لم تعد مشغّلًا في هذه الفعالية.",
  "You are no longer an operator at this event.",
);
export const operatorInvitesFull = make(
  409,
  "operator_invites_full",
  "في الفعالية 500 رمز مشغّل مفتوح. ألغِ بعضها أولًا.",
  "This event has 500 open operator codes. Cancel some first.",
);
export const invalidOperator = make(
  422,
  "invalid_operator",
  "تحقق من بيانات المشغّل.",
  "Check the operator's details.",
);
export const tooManyResets = make(
  429,
  "too_many_resets",
  "غيّرت رمزك 5 مرات اليوم. حاول غدًا.",
  "You changed your code 5 times today. Try again tomorrow.",
);
export const operatorPlayOff = make(
  403,
  "operator_play_off",
  "لم يسمح لك المنظّم باللعب في هذه الفعالية.",
  "The organizer has not allowed you to play this event.",
);
export const eventFull = make(
  409,
  "event_full",
  "اكتمل عدد اللاعبين في هذه الفعالية.",
  "This event is full.",
);
export const alreadyActivated = make(
  409,
  "already_activated",
  "الفعالية مفعّلة من قبل.",
  "This event is already activated.",
);
export const noPendingRequest = make(
  409,
  "no_pending_request",
  "لا يوجد طلب تفعيل بانتظار القرار لهذه الفعالية.",
  "This event has no activation request waiting.",
);
export const notActivated = make(
  409,
  "not_activated",
  "لم تُفعَّل الفعالية بعد.",
  "This event is not activated yet.",
);
export const activationIncomplete = make(
  422,
  "activation_incomplete",
  "لا يمكن تفعيل الفعالية قبل إكمال الحقل المحدد.",
  "The event cannot be activated until the named field is complete.",
);
export const invalidLimit = make(
  422,
  "invalid_limit",
  "حد اللاعبين غير صالح: بلا حد، أو عدد صحيح من 1 إلى 1000000.",
  "The player limit is not valid: none, or a whole number from 1 to 1000000.",
);
export const unknownAddon = make(
  422,
  "unknown_addon",
  "هذه الإضافة غير موجودة في التطبيق.",
  "This add-on does not exist in the app.",
);
export const invalidJoinAnswers = make(
  422,
  "invalid_join_answers",
  "أكمل حقول الانضمام المطلوبة.",
  "Fill in the join fields this event needs.",
);
export const joinInviteOnly = make(
  403,
  "join_invite_only",
  "الانضمام إلى هذه الفعالية بدعوة فقط.",
  "This event is by invitation only.",
);

/** FR-135: the refusal names the domains the event takes, in both languages. */
export const joinDomainRequired = (domains: readonly string[]): HttpError =>
  new HttpError(
    403,
    "join_domain_required",
    {
      ar: `تقبل هذه الفعالية بريدًا مؤكَّدًا على: ${domains.map((d) => `@${d}`).join("، ")}`,
      en: `This event takes a verified email at: ${domains.map((d) => `@${d}`).join(", ")}`,
    },
    { domains },
  );
export const joinFieldsChanged = make(
  409,
  "join_fields_changed",
  "غيّر شخص آخر حقول الانضمام. حدّث الصفحة ثم احفظ.",
  "Someone else changed the join fields. Reload, then save.",
);
export const joinFieldInUse = make(
  409,
  "join_field_in_use",
  'لا يمكن حذف هذا الحقل أو هذا الخيار: إجابات اللاعبين أو قواعد "من يرى ماذا" تستخدمه.',
  'This field or option cannot go: players\' answers or a "Who sees what" rule use it.',
);
export const invalidAudience = make(
  422,
  "invalid_audience",
  "هذه القاعدة غير صالحة. اختر حقلًا بخيارات وخيارًا واحدًا على الأقل، أو وسمًا واحدًا على الأقل.",
  "This rule is not valid. Choose a field with options and at least one option, or at least one tag.",
);
export const guestListFull = make(
  409,
  "guest_list_full",
  "تتجاوز هذه القائمة الحد الأعلى (10000 مدعو).",
  "This would take the guest list over its limit of 10000 entries.",
);
export const deskNeeded = make(
  409,
  "desk_needed",
  "حدّد مكان مكتب الجوائز قبل إضافة جوائز تُستلم منه.",
  "Set the prize desk's place before adding rewards picked up there.",
);
export const deskClosed = make(
  403,
  "desk_closed",
  "مكتب الجوائز مغلق الآن.",
  "The prize desk is closed right now.",
);
export const abilityOff = make(
  403,
  "ability_off",
  "أوقف المنظّم هذه الصلاحية لك.",
  "The owner turned this off for you.",
);
export const notReady = make(
  409,
  "not_ready",
  "اطلب من اللاعب الضغط على «استلام» في تطبيقه أولًا.",
  "Ask the player to tap Collect in their app first.",
);
export const selfHandover = make(
  409,
  "self_handover",
  "لا يمكنك تسليم جائزتك أو إلغاؤها بنفسك.",
  "You cannot hand over or cancel your own reward.",
);
export const handoverMode = make(
  409,
  "handover_mode",
  "تغيّرت طريقة تأكيد الاستلام في هذه الفعالية. حدّث الصفحة.",
  "This event confirms pickups another way now. Refresh and try again.",
);
export const offerGone = make(
  409,
  "offer_gone",
  "انتهى عرض التسليم. اطلب من المكتب إعادة المحاولة.",
  "The handover offer has ended. Ask the desk to try again.",
);
export const overCap = make(
  409,
  "over_cap",
  "هذا أكثر من الحد المسموح للمنح اليدوي.",
  "This is over the manual award limit.",
);
export const selfAward = make(
  403,
  "self_award",
  "لا يمكنك منح النقاط لنفسك.",
  "You cannot award points to yourself.",
);
export const reasonRequired = make(
  400,
  "reason_required",
  "اكتب سببًا من 1 إلى 300 حرف.",
  "Enter a reason of 1 to 300 characters.",
);
export const alreadyRemoved = make(
  409,
  "already_removed",
  "أُزيلت هذه النقاط من قبل.",
  "These points were already removed.",
);
export const openReservation = make(
  409,
  "open_reservation",
  "ألغِ الجائزة المحجوزة لهذا اللاعب أولًا.",
  "Cancel this player's reserved prize first.",
);
export const notRemovable = make(
  422,
  "not_removable",
  "يمكن إزالة النقاط الممنوحة فقط.",
  "Only awarded points can be removed.",
);
export const removalClosed = make(
  409,
  "removal_closed",
  "يمكن إزالة النقاط أثناء الفعالية أو بعد انتهائها فقط.",
  "Points can be removed only during or after the event.",
);
export const tooManyLines = make(
  400,
  "too_many_lines",
  "القائمة أطول من 2000 سطر.",
  "The list is longer than 2000 lines.",
);
export const outsideStation = make(
  403,
  "outside_station",
  "هذه المهمة خارج المهام المسندة إليك.",
  "This quest is outside the quests you were given.",
);
export const heldAtDesk = make(
  409,
  "held",
  "هذه الجائزة معلّقة. اطلب من المالك مراجعتها.",
  "This item is held. Ask the owner.",
);
export const pausedAtDesk = make(
  409,
  "paused",
  "الاستبدال موقوف لهذا اللاعب. اطلب من المالك.",
  "Redeeming is paused for this player. Ask the owner.",
);
export const redeemPaused = make(
  403,
  "redeem_paused",
  "الاستبدال موقوف لك في هذه الفعالية. تواصل مع فريق الفعالية.",
  "Redeeming is paused for you in this event. Ask the event team.",
);
export const caseClosed = make(
  409,
  "resolved",
  "أُغلقت هذه الحالة من قبل.",
  "This case is already closed.",
);
export const noRemoval = make(
  409,
  "no_removal",
  "أزِل النقاط من سجل اللاعب أولًا، ثم أغلق الحالة.",
  "Remove the points from the player's record first, then close the case.",
);
export const rehearsalClosed = make(
  404,
  "rehearsal_closed",
  "رمز التجربة هذا لا يعمل. اطلب الرمز الحالي من فريق الفعالية.",
  "This rehearsal code doesn't work. Ask the event team for the current one.",
);
export const rehearsalFull = make(
  409,
  "rehearsal_full",
  "اكتمل عدد حسابات التجربة لهذه الفعالية.",
  "This event has reached its rehearsal accounts limit.",
);
export const alreadyPlayer = make(
  409,
  "already_player",
  "انضممت إلى هذه الفعالية لاعبًا، فلا يمكن لهذا الحساب أن يشارك في التجربة.",
  "You joined this event as a player, so this account can't rehearse.",
);
export const rehearsing = make(
  409,
  "rehearsing",
  "أنت في تجربة هذه الفعالية. انضم من جديد بعد أن تبدأ.",
  "You're rehearsing this event. Join again after it starts.",
);
export const rehearsalOver = make(
  409,
  "rehearsal_over",
  "بدأت الفعالية، فانتهت التجربة.",
  "The event has started, so rehearsal is over.",
);
export const rehearsalData = make(
  409,
  "rehearsal_data",
  "في هذه الفعالية بيانات تجربة. امسحها أولًا.",
  "This event has rehearsal data. Erase rehearsal first.",
);
export const souvenirData = make(
  409,
  "souvenir_data",
  MESSAGES["souvenir.eventDeleteError"].ar,
  MESSAGES["souvenir.eventDeleteError"].en,
);
// The builder's refusals keep Questify's own words, as its other 409s here do: the dashboard shows an API message as
// sent, so it cannot carry the event's {questOne}/{categoryOne} placeholders that messages.ts texts must use (FR-942).
export const SOUVENIR_IN_USE = {
  category: {
    ar: "يرتبط تذكار بهذه الفئة. احذف مسودة التذكار أولًا. إذا كان التذكار نشطًا أو متوقفًا، فلا يمكن حذف الفئة.",
    en: "A souvenir uses this category. Delete the souvenir draft first. If the souvenir is active or stopped, the category can't be deleted.",
  },
  quest: {
    ar: "هذه المهمة مطلوبة لتذكار نشط أو متوقف، فلا يمكن حذفها.",
    en: "An active or stopped souvenir requires this quest, so the quest can't be deleted.",
  },
  categoryQuest: {
    ar: "لا يمكن حذف مهام هذه الفئة: بعضها مطلوب لتذكار نشط أو متوقف. اختر نقلها إلى فئة أخرى.",
    en: "This category's quests can't be deleted: some are required by an active or stopped souvenir. Choose to move them to another category.",
  },
} as const;
/**
 * A souvenir rule names the category, or an activated souvenir's frozen targets need the quest (T-402b). Deleting a
 * category with its quests names the quest case in the category's own wording.
 */
export const souvenirInUse = (what: "category" | "quest", subject: "category" | "quest") =>
  new HttpError(
    409,
    "souvenir_in_use",
    SOUVENIR_IN_USE[
      what === "category" ? "category" : subject === "category" ? "categoryQuest" : "quest"
    ],
  );
export const resultsFinal = make(
  409,
  "results_final",
  "النتائج مؤكَّدة، فلا يمكن تغيير النقاط أو الجوائز بعد الآن.",
  "The results are confirmed, so points and prizes can't change any more.",
);
export const rankPrizeKept = make(
  409,
  "rank_prize",
  "هذه الجائزة لا تُلغى من التطبيق. تواصل مع فريق الفعالية.",
  "This prize can't be cancelled in the app. Ask the event team.",
);
export const resultsNotEnded = make(
  409,
  "not_ended",
  "تُؤكَّد النتائج بعد انتهاء الفعالية.",
  "Results can be confirmed once the event has ended.",
);
/** A recap asked for before its event ended (T-410): the code results use, with the recap's own words. */
export const recapNotEnded = make(
  409,
  "not_ended",
  "يظهر ملخّصك بعد نهاية الفعالية.",
  "Your recap appears once the event ends.",
);
export const resultsChanged = make(
  409,
  "results_changed",
  "تغيّرت المراكز منذ أن عرضتها. راجعها من جديد ثم أكّد.",
  "The places changed since you looked. Check them again, then confirm.",
);
export const resultsNotConfirmed = make(
  409,
  "not_confirmed",
  "أكّد النتائج أولًا.",
  "Confirm the results first.",
);
export const badDeadline = make(
  409,
  "bad_deadline",
  "اختر موعدًا للاستلام بعد ساعة على الأقل وخلال 60 يومًا.",
  "Pick a claim deadline at least 1 hour away and within 60 days.",
);
export const deskClosedUntilDeadline = make(
  409,
  "desk_closed_until_deadline",
  "منصة الجوائز لا تفتح قبل هذا الموعد. أضف ساعات عمل قبله أو اختر موعدًا أبعد.",
  "The prize desk doesn't open before this deadline. Add desk hours before it or pick a later one.",
);
export const prizesLocked = make(
  409,
  "prizes_locked",
  "بدأت الفعالية، فلا يمكن تغيير مراكز الجوائز. يمكنك تعديل الأسماء والأوصاف فقط.",
  "The event has started, so prize ranks can't change. You can still edit names and descriptions.",
);
export const prizeOverlap = make(
  409,
  "overlap",
  "جائزة أخرى تغطي بعض هذه المراكز.",
  "Another prize already covers some of these ranks.",
);
export const prizeRemoved = make(
  409,
  "removed",
  "حُذفت هذه الجائزة، فلا يمكن تعديلها.",
  "This prize was removed, so it can't be edited.",
);
export const joinDeclined = make(
  403,
  "join_declined",
  "رفض المنظّم طلب انضمامك إلى هذه الفعالية.",
  "The organizer declined your request to join this event.",
);
export const requestEventOver = make(
  409,
  "event_over",
  "الفعالية ليست مجدولة ولا جارية، فلا يمكن البتّ في الطلبات.",
  "The event is not scheduled or live, so requests cannot be decided.",
);
export const notARequest = make(
  409,
  "not_a_request",
  "لا يوجد طلب انضمام لهذا اللاعب.",
  "This player has no join request.",
);
export const deletionExpired = make(
  410,
  "deletion_expired",
  "انتهت صلاحية هذه الخطوة. ابدأ حذف الحساب من جديد.",
  "This step has expired. Start deleting the account again.",
);
export const handoverPending = make(
  409,
  "handover_pending",
  "لديك جوائز لم تستلمها بعد. وافق على التنازل عنها لحذف الحساب.",
  "You have prizes not collected yet. Agree to give them up to delete the account.",
);
export const guidelinesRequired = make(
  403,
  "guidelines_required",
  "اقرأ إرشادات المجتمع ووافق عليها قبل أول مشاركة.",
  "Read and accept the community guidelines before your first submission.",
);
export const notSubmissionQuest = make(
  422,
  "not_submission_quest",
  "هذه المهمة لا تستقبل مشاركات.",
  "This quest does not take submissions.",
);
export const submissionText = make(
  422,
  "submission_text",
  "اكتب نصًا من 1 إلى 1000 حرف بلا رموز خفية.",
  "Write 1 to 1000 characters, with no hidden characters.",
);
export const submissionPending = make(
  409,
  "submission_pending",
  "مشاركتك السابقة في هذه المهمة بانتظار المراجعة.",
  "Your earlier submission for this quest is still waiting for review.",
);
export const submissionClosed = make(
  409,
  "submission_closed",
  "رُفضت مشاركتك، ولا تقبل هذه المهمة مشاركة أخرى.",
  "Your submission was rejected and this quest does not take another one.",
);
export const submissionKindUnavailable = make(
  422,
  "submission_kind_unavailable",
  "إرسال الصور أو الفيديو غير متاح بعد. المتاح الآن هو النص.",
  "Photo and video submissions are not available yet. Text is available now.",
);
export const alreadyReviewed = make(
  409,
  "already_reviewed",
  "راجع أحد أعضاء الفريق هذه المشاركة من قبل.",
  "Someone on the team already reviewed this submission.",
);
export const notApprovable = make(
  409,
  "not_approvable",
  "لا يمكن قبول هذه المشاركة الآن: اللاعب غادر الفعالية أو أُغلقت الفعالية.",
  "This submission can't be approved now: the player left or the event is closed.",
);
export const selfReview = make(
  403,
  "self_review",
  "لا يمكنك مراجعة مشاركتك.",
  "You cannot review your own submission.",
);
export const notApproved = make(
  409,
  "not_approved",
  "يمكن إزالة المشاركات المقبولة فقط.",
  "Only an approved submission can be removed.",
);
export const questLocked = make(
  409,
  "quest_locked",
  "بدأ اللاعبون هذه المهمة، فيمكن تعديل النصوص فقط، لا الخيارات ولا الإجابات ولا المؤقت.",
  "Players have started this quest, so only its text can change, not its options, answers or timer.",
);
export const pollLocked = make(
  409,
  "poll_locked",
  "اجعل التصويت مباشرًا وهو مخفي ولم يُرسَل ولا أصوات فيه. وبعد إرساله لا يتغيّر عدد الاختيارات ولا المدة.",
  "Make a vote live while it is hidden, unsent and without votes. Once sent, its choices and minutes stay as they are.",
);
export const notLivePoll = make(
  422,
  "not_live_poll",
  "هذه المهمة ليست تصويتًا مباشرًا.",
  "This quest is not a live poll.",
);
/** A live poll whose quest or category a community goal still locks is not sent (T-306c, CTO 7). */
export const pollCommunityLocked = make(
  409,
  "community_locked",
  "يفتح هدفٌ جماعي هذا التصويت أو فئته، فلا يُرسل قبل تحقيقه.",
  "A community goal unlocks this poll or its category, so it can't be sent until the goal is reached.",
);
export const pollAlreadySent = make(
  409,
  "already_sent",
  "أُرسل هذا التصويت وأُغلق، فلا يمكن إرساله مرة أخرى.",
  "This poll was sent and has closed, so it cannot be sent again.",
);
export const pollNotSent = make(
  409,
  "not_sent",
  "لم يُرسَل هذا التصويت بعد.",
  "This poll has not been sent yet.",
);
export const pollEventNotLive = make(
  409,
  "event_not_live",
  "أرسل التصويت عندما تكون الفعالية مباشرة أو أثناء التجربة.",
  "Send the poll while the event is live, or during a rehearsal.",
);
export const tooManyChoices = make(
  422,
  "too_many_choices",
  "اختر إجابة واحدة فقط.",
  "Pick only one choice.",
);
export const notVoteQuest = make(
  422,
  "not_vote_quest",
  "هذه المهمة ليست تصويتًا.",
  "This quest is not a vote.",
);
export const notQuizQuest = make(
  422,
  "not_quiz_quest",
  "هذه المهمة ليست اختبارًا.",
  "This quest is not a quiz.",
);
export const notSurveyQuest = make(
  422,
  "not_survey_quest",
  "هذه المهمة ليست استبيانًا.",
  "This quest is not a survey.",
);
export const notShareQuest = make(
  422,
  "not_share_quest",
  "هذه المهمة ليست مهمة مشاركة.",
  "This quest is not a share quest.",
);
export const notPassportQuest = make(
  422,
  "not_passport_quest",
  "هذه المهمة ليست جوازًا.",
  "This quest is not a passport.",
);
export const notMeetQuest = make(
  422,
  "not_meet_quest",
  "هذه المهمة ليست مهمة تعارف.",
  "This quest is not a meet quest.",
);
/**
 * A meeting refused (T-303c): `reason` says why, with `name` for already_met and `cap` for daily_cap. One code, three
 * statuses: the code itself (422), a limit or the pair (409), who may meet (403).
 */
export const meetRefused422 = make(
  422,
  "meet_refused",
  "تعذّر استخدام رمز التعارف هذا.",
  "This meet code can't be used.",
);
export const meetRefused409 = make(
  409,
  "meet_refused",
  "تعذّر التعارف الآن.",
  "You can't meet right now.",
);
export const meetRefused403 = make(
  403,
  "meet_refused",
  "تعذّر التعارف في هذه المهمة.",
  "This meeting isn't open.",
);
/** A survey answer its question does not take; `question` names it (never the answer itself). */
export const badAnswer = make(
  422,
  "bad_answer",
  "راجع إجابتك عن هذا السؤال.",
  "Check your answer to this question.",
);
export const featureOff = make(
  403,
  "feature_off",
  "أوقف المنظّم هذه الميزة في الفعالية.",
  "The organizer turned this off for the event.",
);
/** A platform-wide switch is off (location quests until the store privacy answers are updated, ADR-208). */
export const platformFeatureOff = make(
  403,
  "feature_off",
  "هذه الميزة غير متاحة حاليًا.",
  "This is not available yet.",
);
/**
 * A location check-in was refused (T-303b): `reason` is no_position, bad_position, stale, imprecise or not_here, and
 * `distanceM` the player's own rounded distance for not_here. Never the coordinates sent.
 */
export const locationRefused = make(
  422,
  "location_refused",
  "تعذّر تسجيل حضورك هنا. امسح رمز QR الموجود في المكان بدلًا من ذلك.",
  "We couldn't check you in here. Scan the QR code at the spot instead.",
);
export const unknownOption = make(
  422,
  "unknown_option",
  "هذا الخيار غير موجود في المهمة.",
  "That choice is not in this quest.",
);
export const alreadyVoted = make(409, "already_voted", "صوّتَّ من قبل.", "You have already voted.");
export const quizNotStarted = make(
  404,
  "quiz_not_started",
  "ابدأ الاختبار أولًا.",
  "Start the quiz first.",
);
export const alreadyAnswered = make(
  409,
  "already_answered",
  "أجبت عن هذا السؤال من قبل.",
  "You already answered this question.",
);
export const questionClosed = make(
  409,
  "question_closed",
  "انتهى وقت هذا السؤال.",
  "Time is up for this question.",
);
export const questionNotServed = make(
  409,
  "question_not_served",
  "هذا السؤال لم يُفتح بعد.",
  "This question is not open yet.",
);
/**
 * A secret code posted for a category that is not hidden (T-304c): only ever answered to a holder of its code. Also the
 * team's hint on a category that is not hidden (T-501g).
 */
export const categoryNotHidden = make(
  422,
  "not_hidden",
  "هذه الفئة ليست مخفية.",
  "This category is not hidden.",
);
/** A hint sent when no player can play: the event is not live and has no open rehearsal (T-501g). */
export const hintEventNotLive = make(
  409,
  "event_not_live",
  "أرسل التلميح عندما تكون الفعالية مباشرة أو أثناء التجربة.",
  "Send the hint while the event is live, or during a rehearsal.",
);
/** A second hint of a category while the first is still being delivered (T-501g). */
export const hintInProgress = make(
  409,
  "hint_in_progress",
  "ما زال التلميح السابق في الطريق. جرّب بعد دقيقة.",
  "The last hint is still on its way. Try again in a minute.",
);
/** A hint pressed when no one is left to tell: everyone it reaches already got one, or no one has joined (T-501g). */
export const hintNobody = make(
  409,
  "hint_nobody",
  "لا أحد لإبلاغه الآن. من وصله تلميح من قبل لا يصله مرة أخرى.",
  "No one is left to tell. Anyone who already got a hint is not told again.",
);
/** The push store could not take the hint's notice (T-501g): nothing was sent, so the press may be tried again. */
export const hintNotSent = make(
  503,
  "hint_unavailable",
  "تعذّر إرسال التلميح. جرّب مرة أخرى بعد قليل.",
  "The hint could not be sent. Try again in a moment.",
);
/** A secret code that does not open this category (T-304c): one answer whatever the problem; the log tells them apart. */
export const revealCodeInvalid = make(
  422,
  "invalid_code",
  "هذا الرمز لا يكشف هذه الفئة.",
  "This code does not open this category.",
);
/** A quest or category naming a quest item that is removed or another event's (T-304d). */
export const invalidItem = make(
  422,
  "invalid_item",
  "اختر هديةً من هدايا هذه الفعالية.",
  "Choose an item from this event's quest items.",
);
/** A quest item a quest or category still gives (T-304d): unlink it first. */
export const itemInUse = make(
  409,
  "item_in_use",
  "هذه الهدية مرتبطة بمهام أو فئات. ألغِ ربطها أولًا.",
  "Quests or categories still give this item. Unlink it first.",
);
export const notGameQuest = make(
  422,
  "not_game_quest",
  "هذه المهمة ليست لعبة مصغّرة.",
  "This quest is not a mini-game.",
);
/** The app's engine for this game is older than the server's (T-305, ADR-212): checked before an attempt is used. */
export const updateRequired = make(
  426,
  "update_required",
  "حدّث التطبيق لتلعب هذه اللعبة.",
  "Update the app to play this game.",
);
/**
 * A mini-game round refused (T-305): `reason` says why. 409 for the round or the attempts (attempts_used, cooldown with
 * `retryAt`, expired, finished); 422 `impossible` when the replay refused the round, which counts as played. The
 * replay's own reason never reaches the player.
 */
export const gameRefused409 = make(
  409,
  "game_refused",
  "لا يمكن اللعب بهذه الجولة الآن.",
  "This round can't be played now.",
);
export const gameRefused422 = make(
  422,
  "game_refused",
  "تعذّر احتساب هذه الجولة.",
  "This round couldn't be counted.",
);
/** A community goal's body broke a rule (T-306b): `issues` names the fields. */
export const invalidGoal = make(
  422,
  "invalid_goal",
  "راجع بيانات المهمة الجماعية.",
  "Check the community quest's details.",
);
/** Another community goal of the event runs at that time (T-306b): one runs at a time. */
export const goalOverlap = make(
  409,
  "goal_overlap",
  "تتداخل هذه المدة مع مهمة جماعية أخرى في الفعالية.",
  "Another community quest runs at that time.",
);
/** A started community goal keeps everything but its texts (T-306b): `field` names what would change. */
export const goalLocked = make(
  409,
  "goal_locked",
  "بدأت المهمة الجماعية، فلا يتغيّر فيها إلا النصوص.",
  "This community quest has started: only its texts can change.",
);
/** A started community goal stays (T-306b). */
export const goalStarted = make(
  409,
  "goal_started",
  "بدأت المهمة الجماعية، فلا يمكن حذفها.",
  "This community quest has started, so it can't be deleted.",
);
/** No new community goal once the event ended or its results exist (T-306b). */
export const goalEventEnded = make(
  409,
  "event_ended",
  "انتهت الفعالية، فلا تُضاف إليها مهام جماعية.",
  "The event has ended, so no community quest can be added.",
);
/** A quest or category a community goal counts (T-306b) or unlocks (T-306c) cannot be deleted. */
export const goalInUse = make(
  409,
  "goal_in_use",
  "تحتسب مهمة جماعية هذا العنصر أو تفتحه. عدّلها أو احذفها أولًا.",
  "A community quest counts or unlocks this. Change or delete it first.",
);
/** A community goal already unlocks this quest, category or shop reward (T-306c): each is unlocked once. */
export const unlockTaken = make(
  409,
  "unlock_taken",
  "تفتح مهمة جماعية أخرى هذا العنصر. اختر غيره.",
  "Another community quest already unlocks this. Pick something else.",
);
/** A transaction from a goal's window is still open (T-306b): settle again after `Retry-After`. */
export const communitySettling = make(
  409,
  "community_settling",
  "ما زلنا نحسب آخر النقاط. حاول بعد لحظات.",
  "The last points are still being counted. Try again in a moment.",
);
/** The results wait until every community goal is final and paid (T-306b): `goals` and `due` say what is left. */
export const communityPaying = make(
  409,
  "community_paying",
  "ما زالت المكافآت الجماعية قيد الصرف.",
  "Community rewards are still being paid.",
);
/** A boost's body broke a rule (T-307): `issues` names the fields (category, startsAt, minutes, outside_event). */
export const invalidBoost = make(
  422,
  "invalid_boost",
  "راجع بيانات مضاعفة النقاط: الفئة أو وقت البدء أو المدة.",
  "Check the boost's details: its category, start or length.",
);
/** Another boost runs on the same category at that time (T-307): one at a time. */
export const boostOverlap = make(
  409,
  "boost_overlap",
  "تعمل مضاعفة أخرى على هذه الفئة في الوقت نفسه.",
  "Another boost runs on this category at that time.",
);
/** A boost less than a minute before its start, or one that paid, can only be stopped (T-307, ADR-232). */
export const boostStarted = make(
  409,
  "boost_started",
  "بدأت المضاعفة أو أوشكت أن تبدأ، فيمكن إيقافها فقط.",
  "This boost has started or is about to, so it can only be stopped.",
);
/** Stop before a boost's start (T-307): delete it instead, until a minute before the start. */
export const boostNotStarted = make(
  409,
  "not_started",
  "لم تبدأ المضاعفة بعد. احذفها بدلًا من إيقافها.",
  "This boost hasn't started yet. Delete it instead.",
);
/** No boost once the event ended or its results exist (T-307). */
export const boostEventEnded = make(
  409,
  "event_ended",
  "انتهت الفعالية، فلا تُضاف إليها مضاعفات.",
  "The event has ended, so no boost can be added.",
);
/** A category with a boost cannot be deleted (T-307, the boost's key). */
export const boostInUse = make(
  409,
  "boost_in_use",
  "لهذه الفئة مضاعفة نقاط، فلا يمكن حذفها.",
  "This category has a boost, so it can't be deleted.",
);
/** Launch or End now on a quest that is not a flash quest (T-307). */
/** New points in a live event with real completions: future completions only, or also past (T-604, FR-411). */
export const applyRequired = make(
  409,
  "apply_required",
  "أنجز اللاعبون هذه المهمة: اختر هل تُطبَّق النقاط الجديدة على الإنجازات القادمة فقط أم على السابقة أيضًا.",
  "Players have completed this quest: choose whether the new points apply to future completions only or to past ones too.",
);
/** A played quest's delete: keep or remove its points (T-604, FR-412). */
export const pointsChoiceRequired = make(
  409,
  "points_choice_required",
  "أنجز اللاعبون هذه المهمة: اختر هل تبقى نقاطها أم تُسحب.",
  "Players have completed this quest: choose whether its points stay or are removed.",
);
/** "Also past" goes with an Idempotency-Key (T-604). */
export const pastKeyRequired = make(
  400,
  "idempotency_key_required",
  "يلزم مفتاح منع التكرار لهذا الطلب.",
  "This request needs an Idempotency-Key.",
);
/** Past points change only while the event is live (T-604). */
export const pastNotLive = make(
  409,
  "event_not_live",
  "يمكن تعديل نقاط الإنجازات السابقة أثناء سير الفعالية فقط.",
  "Past completions' points change only while the event is live.",
);
/** Only a step of an in-order category can be skipped (T-603b): not a flash quest or a live poll. */
export const notInOrder = make(
  422,
  "not_in_order",
  "يمكن تخطي خطوة في فئة مرتبة فقط.",
  "Only a step in an in-order category can be skipped.",
);
export const notFlashQuest = make(
  422,
  "not_flash",
  "هذه المهمة ليست مهمة خاطفة.",
  "This quest is not a flash quest.",
);
/** A flash quest runs once (T-307, ADR-231): launched and ended, it can't be launched again. */
export const flashAlreadyLaunched = make(
  409,
  "already_launched",
  "انطلقت هذه المهمة الخاطفة وانتهت، فلا يمكن إطلاقها مرة أخرى.",
  "This flash quest ran and has ended, so it can't be launched again.",
);
/** A scheduled flash quest runs at its own times (T-307): hide it to launch it by hand. */
export const flashScheduled = make(
  409,
  "flash_scheduled",
  "لهذه المهمة الخاطفة موعد محدد. أخفها أولًا لتطلقها يدويًا.",
  "This flash quest has its own times. Hide it first to launch it by hand.",
);
/** A flash quest a community goal still locks is not launched (T-307, as Send, ADR-228). */
export const flashCommunityLocked = make(
  409,
  "community_locked",
  "يفتح هدفٌ جماعي هذه المهمة أو فئتها، فلا تنطلق قبل تحقيقه.",
  "A community goal unlocks this quest or its category, so it can't be launched until the goal is reached.",
);
/** Less than a minute is left before the event's end (T-307). */
export const flashTooLate = make(
  409,
  "too_late",
  "بقي على نهاية الفعالية أقل من دقيقة.",
  "Less than a minute is left before the event ends.",
);
/** End now on a flash quest whose window has not started (T-307, CTO 10): edit or hide it instead. */
export const flashNotStarted = make(
  409,
  "not_started",
  "لم تبدأ هذه المهمة الخاطفة بعد. عدّلها أو أخفها بدلًا من ذلك.",
  "This flash quest hasn't started yet. Edit or hide it instead.",
);
/** Launch outside a live event or a rehearsal (T-307). */
export const flashEventNotLive = make(
  409,
  "event_not_live",
  "أطلق المهمة الخاطفة عندما تكون الفعالية مباشرة أو أثناء التجربة.",
  "Launch the flash quest while the event is live, or during a rehearsal.",
);
/** A tap on a tag that is not registered, was revoked or is not of an event the player is in (T-308). */
export const unknownTag = make(
  404,
  "unknown_tag",
  "لم نتعرّف على هذه البطاقة. امسح رمز QR الخاص بالمهمة.",
  "We don't recognize this tag. Scan the quest's QR code instead.",
);
/** A tag's address that is not a Questify tag, or not signed by Questify (T-308); logged apart. */
export const invalidProof = make(
  422,
  "invalid_proof",
  "هذه البطاقة لا تعمل في Questify.",
  "This tag doesn't work with Questify.",
);
/** Writing a tag for a quest that is not a scan quest with NFC on (T-308). */
export const questNotNfc = make(
  409,
  "not_nfc",
  "هذه المهمة لا تستخدم بطاقة NFC.",
  "This quest doesn't use an NFC tag.",
);
/** A second confirm of one prepared tag (T-308, CTO C): prepare a new one. */
export const tagAlreadyRegistered = make(
  409,
  "already_registered",
  "سُجّلت هذه البطاقة من قبل. ابدأ كتابة جديدة.",
  "This tag is already registered. Start a new write.",
);
/** A tag write whose details are not valid (T-308): `field` names which (code, ticket, uid, label). */
export const invalidTag = make(
  422,
  "invalid_tag",
  "تعذّر تسجيل البطاقة. ابدأ كتابة جديدة.",
  "The tag couldn't be registered. Start a new write.",
);
/** A quest with NFC tags cannot be deleted (T-308, the tag's key): revoke them first. */
export const tagsInUse = make(
  409,
  "tags_in_use",
  "لهذه المهمة بطاقات NFC، فألغِها أولًا.",
  "This quest has NFC tags. Revoke them first.",
);
/** No tag is written once the event ended (T-308). */
export const tagEventClosed = make(
  409,
  "event_closed",
  "انتهت الفعالية، فلا تُكتب لها بطاقات.",
  "The event has ended, so no tags can be written.",
);
/** An operator limited to some quests writing a tag for another (T-308). */
export const outsideOperatorQuests = make(
  403,
  "outside_quests",
  "هذه المهمة ليست من مهامك.",
  "This quest isn't one of yours.",
);

// ---------------------------------------------------------------- devices (T-309)
/** A device cookie that opens no live device (revoked, ended, unknown): the page starts over at pairing. */
export const deviceUnpaired = make(
  401,
  "device_unpaired",
  "هذه الشاشة غير مرتبطة. اطلب من فريق الفعالية ربطها.",
  "This screen isn't paired. Ask the event team to pair it.",
);
/** A pairing code that is unknown, expired or already claimed: one answer for all three. */
export const unknownPairingCode = make(
  404,
  "unknown_code",
  "لم نجد هذا الرمز أو انتهت صلاحيته. اطلب رمزًا جديدًا من الشاشة.",
  "We couldn't find this code, or it expired. Get a new code from the screen.",
);
/** A device of this event that is unknown, already revoked, or not one the operator paired. */
export const unknownDevice = make(
  404,
  "unknown_device",
  "لم نجد هذا الجهاز.",
  "We couldn't find this device.",
);
/** Pairing for an event that has ended. */
export const deviceEventClosed = make(
  409,
  "event_closed",
  "انتهت الفعالية، فلا تُربط بها أجهزة.",
  "The event has ended, so no devices can be paired.",
);
/** A station for a quest without the screen QR. */
export const notScreenQr = make(
  409,
  "not_screen_qr",
  "هذه المهمة لا تستخدم رمز QR على شاشة.",
  "This quest doesn't use a QR on a screen.",
);
/** A kiosk for a quest without the kiosk method (T-309b). */
export const notKiosk = make(
  409,
  "not_kiosk",
  "هذه المهمة لا تستخدم كشكًا ذاتيًا.",
  "This quest doesn't use a kiosk.",
);
/** The page shows another kind of device than the one chosen. */
export const wrongDeviceKind = make(
  409,
  "wrong_kind",
  "هذه الشاشة من نوع آخر. افتح الصفحة الصحيحة على الجهاز.",
  "This screen is another kind of device. Open the right page on it.",
);
/** A claim's field the database refused: `field` is kind, quest or label. */
export const invalidDevice = make(
  422,
  "invalid_device",
  "تحقق من بيانات الجهاز.",
  "Check the device's details.",
);
/** Too many pairing requests at once (the flood cap) or no free code: try again shortly. */
export const pairingBusy = make(
  503,
  "busy",
  "الخدمة مشغولة الآن. حاول بعد قليل.",
  "We're busy right now. Try again in a moment.",
);
/** A screen code whose window has passed: the screen shows a new one. */
export const screenCodeExpired = make(
  422,
  "code_expired",
  "تغيّر هذا الرمز. امسح الشاشة مجددًا.",
  "This code has changed. Scan the screen again.",
);

// ---------------------------------------------------------------- the big screen's scenes (T-504)
/** A scene list the database refused: `field` is scenes (unknown, repeated or too many) or ranking_off. */
export const invalidBigScreen = make(
  422,
  "invalid_big_screen",
  "تحقق من مشاهد الشاشة الكبيرة.",
  "Check the big screen's scenes.",
);
/** The big-screen add-on is not active for this event: only Questify unlocks it (FR-1729). */
export const bigScreenOff = make(
  403,
  "big_screen_off",
  "الشاشة الكبيرة غير مفعّلة لهذه الفعالية. تواصل مع كويستفاي لتفعيلها.",
  "The big screen isn't active for this event. Ask Questify to activate it.",
);

// ---------------------------------------------------------------- the live finale (T-307b)
/** A finale the database refused: `field` is startsAt, goal, goal_done or goal_window. */
export const invalidFinale = make(
  422,
  "invalid_finale",
  "تحقق من وقت الختام وهدفه الجماعي.",
  "Check the finale's time and its community goal.",
);
/** The finale's time has come: it can no longer change, only be cleared. */
export const finaleStarted = make(
  409,
  "finale_started",
  "بدأ الختام ولا يمكن تغييره. يمكنك إلغاؤه فقط.",
  "The finale has started and can't be changed. You can only clear it.",
);

// ---------------------------------------------------------------- the help desk (T-310)
/** Only an active member of the event sends requests; the same answer whether or not the event exists. */
export const ticketNotMember = make(
  403,
  "not_member",
  "إرسال الطلبات للأعضاء النشطين في هذه الفعالية فقط.",
  "Only active members of this event can send requests.",
);
/** The event is a draft, archived, or ended more than 30 days ago: answers already given stay readable. */
export const ticketSendingClosed = make(
  403,
  "sending_closed",
  "لم يعد بإمكانك إرسال طلبات جديدة في هذه الفعالية، وتبقى الردود هنا.",
  "You can't send new requests for this event. Your answers stay here.",
);
/** The quest named is not one of this event's. */
export const ticketUnknownQuest = make(
  404,
  "unknown_quest",
  "لم نجد هذه المهمة في الفعالية.",
  "We couldn't find this quest in the event.",
);
/** The text or the reply is empty, too long, or holds hidden characters: `problem` says which. */
export const ticketText = make(
  422,
  "invalid_text",
  "اكتب نصًا من 1 إلى 1000 حرف بلا رموز خفية.",
  "Write 1 to 1000 characters, with no hidden characters.",
);
/** Three requests already wait for an answer in this event. */
export const tooManyOpenTickets = make(
  409,
  "too_many_open",
  "لديك 3 طلبات بانتظار الرد. انتظر الرد قبل إرسال طلب آخر.",
  "You have 3 requests waiting. Wait for an answer before sending another.",
);
/** Ten requests in 24 hours in this event: try again after `Retry-After`. */
export const tooManyTickets = make(
  429,
  "too_many_tickets",
  "أرسلت طلبات كثيرة اليوم. حاول مرة أخرى لاحقًا.",
  "You've sent many requests today. Try again later.",
);
/** Someone on the team answered or solved it first: the request is closed. */
export const ticketAlreadyClosed = make(
  409,
  "already_closed",
  "أغلق أحد أعضاء الفريق هذا الطلب.",
  "Someone on the team already closed this.",
);
/** The event is archived, so its requests can no longer be answered. */
export const ticketEventClosed = make(
  409,
  "event_closed",
  "أُرشفت الفعالية، فلا يمكن الرد على طلباتها.",
  "The event is archived, so its requests can't be answered.",
);
/** An operator who plays the event cannot answer their own request. */
export const selfAnswer = make(
  403,
  "self_answer",
  "لا يمكنك الرد على طلبك.",
  "You can't answer your own request.",
);

// ---------------------------------------------------------------- the ticket center (T-312)
/** No active member of this event has that username: the same answer for an account outside the event. */
export const ticketUnknownPlayer = make(
  404,
  "unknown_player",
  "لا يوجد لاعب بهذا الاسم في هذه الفعالية.",
  "No player with this username in this event.",
);
/** A player cannot report themselves. */
export const ticketSelfReport = make(
  403,
  "self_report",
  "لا يمكنك الإبلاغ عن نفسك.",
  "You can't report yourself.",
);
/** One open report per reporter and reported member. */
export const ticketAlreadyReported = make(
  409,
  "already_reported",
  "سبق أن أبلغت عن هذا اللاعب، وسيراجع فريق الفعالية البلاغ.",
  "You already reported this player. The event team will look at it.",
);
/** A report names the player's username. */
export const ticketUsernameRequired = make(
  422,
  "username_required",
  "اكتب اسم مستخدم اللاعب.",
  "Write the player's username.",
);
/** Ten usernames not found in this event within the hour: try again after `Retry-After`. */
export const tooManyLookups = make(
  429,
  "too_many_lookups",
  "حاولت أسماء كثيرة. حاول مرة أخرى لاحقًا.",
  "You've tried many usernames. Try again later.",
);
/** The ticket is closed already, so it cannot be escalated. */
export const ticketNotOpen = make(409, "not_open", "أُغلق هذا الطلب.", "This request is closed.");
/** The ticket changed queue (escalated, or sent back) since it was read. */
export const ticketMoved = make(
  409,
  "moved",
  "انتقل هذا الطلب. حدّث الصفحة.",
  "This request moved. Refresh the page.",
);
/** Only an escalated event ticket goes back to the event team: an app problem or a suggestion has none. */
export const ticketNotEscalated = make(
  409,
  "not_escalated",
  "لا يمكن إعادة هذا الطلب: لم تُحِله فعالية.",
  "This request can't be sent back: no event sent it.",
);
/** A real player got the quest's first-N bonus (T-313): its points stay and it cannot be switched off. */
export const firstBonusPaid = make(
  409,
  "first_bonus_paid",
  "حصل لاعبون على هذه المكافأة، فلا يمكن تغيير نقاطها ولا إلغاؤها.",
  "Players already got this bonus, so its points can't change and it can't be removed.",
);
/** Fewer first-N bonuses than players who already got one (T-313); `given` is that number. */
export const belowGiven = make(
  409,
  "below_given",
  "لا يقل العدد عن اللاعبين الذين حصلوا على المكافأة.",
  "The number can't be below the players who already got this bonus.",
);
/** The first-N bonus's points or players are out of range (T-313); `field` names which. */
export const invalidFirstBonus = make(
  422,
  "invalid_first_bonus",
  "نقاط المكافأة من 1 إلى 100,000، وعدد اللاعبين من 1 إلى 1,000.",
  "Bonus points are 1 to 100,000, and players 1 to 1,000.",
);
/**
 * The event streak's settings can't change now (T-405): `reason` is single_day, day_started (with the first started
 * `day` the change would touch), results_final or archived.
 */
export const streakConflict = make(
  409,
  "streak_conflict",
  "لا يمكن تغيير سلسلة الأيام الآن.",
  "The streak can't be changed now.",
);
/** A streak setting is out of range (T-405); `field` names which. */
export const invalidStreak = make(
  422,
  "invalid_streak",
  "إعدادات سلسلة الأيام غير صحيحة.",
  "The streak settings aren't valid.",
);
/** The daily game is switched off for the platform (T-406, ADR-312). */
export const dailyUnavailable = make(
  404,
  "daily_unavailable",
  "هذه اللعبة غير متاحة الآن.",
  "This game isn't available right now.",
);
/**
 * A daily move that can't be taken now (T-406): `reason` is period_over, changed, out_of_order, answered,
 * attempt_taken, finished or other_language. The app refreshes the game.
 */
export const dailyConflict = make(
  409,
  "daily_conflict",
  "تعذّر قبول هذه الخطوة الآن. حدّث اللعبة وحاول مرة أخرى.",
  "This move can't be accepted now. Refresh the game and try again.",
);
/** A daily challenge answer out of range (T-406); `field` is position or choice. */
export const invalidAnswer = make(
  422,
  "invalid_answer",
  "تعذّر قبول هذه الإجابة. حدّث اللعبة وحاول مرة أخرى.",
  "This answer can't be accepted. Refresh the game and try again.",
);
/** A refused daily word guess (T-406): `reason` is length, letters or not_a_word; no try is used. */
export const invalidGuess = make(
  422,
  "invalid_guess",
  "هذه الكلمة غير مقبولة، ولم تُحتسب محاولة.",
  "That word isn't accepted. No try was used.",
);
/**
 * A console change to daily content that can't be made now (T-406): `reason` is started, scheduled, used, retired or
 * changed; `position` names the question at fault.
 */
export const dailyContentConflict = make(
  409,
  "daily_content_conflict",
  "لا يمكن إجراء هذا التغيير الآن. راجع حالة المحتوى اليومي.",
  "This change isn't possible now. Check the daily content's status.",
);
/** Daily content the console sent is not valid (T-406); `field` names which. */
export const invalidDaily = make(
  422,
  "invalid_daily",
  "راجع بيانات المحتوى اليومي: الحقل المحدد غير صالح.",
  "Check the daily content: the named field isn't valid.",
);
/**
 * The event cannot take a Questify invitation now (T-409): `reason` is not_public, not_running, ends_soon, link_off,
 * guest_list_only or email_domains. 409 for the owner's request.
 */
export const invitationNotEligible = make(
  409,
  "event_not_eligible",
  "هذه الفعالية لا تقبل الدعوات الآن. راجع إعدادات الوصول والانضمام.",
  "This event can't take invitations now. Check its access and joining settings.",
);
/** The same at the admin's approval (T-409), answered 422 there. */
export const approvalNotEligible = make(
  422,
  "event_not_eligible",
  "هذه الفعالية لا تقبل الدعوات الآن. راجع إعدادات الوصول والانضمام.",
  "This event can't take invitations now. Check its access and joining settings.",
);
/** The event already has a requested, approved or sending invitation campaign (T-409). */
export const invitationAlreadyOpen = make(
  409,
  "invitation_open",
  "لهذه الفعالية حملة دعوات مفتوحة. ألغِها أو انتظر انتهاءها.",
  "This event already has an open invitation campaign. Cancel it or wait for it to end.",
);
/** The campaign's state does not allow this step (T-409); the page refreshes. */
export const invitationWrongState = make(
  409,
  "wrong_state",
  "لا يمكن تنفيذ هذا في حالة الحملة الحالية. حدّث الصفحة.",
  "This can't be done in the campaign's current state. Refresh the page.",
);
/** The event was renamed after the console read it (T-409, Finding 1 (a)): the admin approves the new text again. */
export const invitationEventRenamed = make(
  409,
  "event_renamed",
  "تغيّر اسم الفعالية بعد فتح الصفحة. حدّث الصفحة وراجع نص الرسالة قبل الموافقة.",
  "The event was renamed after you opened this page. Refresh it and check the message before approving.",
);
/** One request key was used for another invitation request (T-409). */
export const invitationKeyMismatch = make(
  409,
  "idempotency_mismatch",
  "استُخدم مفتاح الطلب هذا لطلب مختلف. أرسل الطلب من جديد.",
  "This request key was used for a different request. Send the request again.",
);
/** An invitation request the database refused (T-409); `field` names which. */
export const invalidInvitation = make(
  422,
  "invalid_invitation",
  "راجع طلب الدعوات: الحقل المحدد غير صالح.",
  "Check the invitation request: the named field isn't valid.",
);
/** An approval the database refused (T-409); `field` names which. */
export const invalidApproval = make(
  422,
  "invalid_approval",
  "راجع الموافقة: الحقل المحدد غير صالح.",
  "Check the approval: the named field isn't valid.",
);
/** No promotional sender is set up for this channel on this server (T-409, ADR-331 (1)); `channel` names it. */
export const channelUnavailable = make(
  422,
  "channel_unavailable",
  "لا يمكن الإرسال عبر هذه القناة الآن: لم يُضبط مرسل الرسائل الترويجية.",
  "This channel can't send yet: no promotional sender is set up.",
);
/**
 * An event name the invitation SMS cannot carry (T-409, the name rule): `language` is ar or en, `reason`
 * control_characters, looks_like_address or looks_like_phone.
 */
export const invitationEventName = make(
  422,
  "event_name",
  "اسم الفعالية لا يصلح لرسالة نصية: يشبه رابطًا أو رقم هاتف، أو فيه رموز مخفية. عدّل الاسم.",
  "The event's name can't go in a text message: it looks like a link or a phone number, or holds hidden characters. Edit the name.",
);
/** The invitation link is unknown, removed after 90 days, or its event is over (T-409). */
export const invitationEnded = make(
  404,
  "invitation_ended",
  "انتهت هذه الدعوة.",
  "This invitation has ended.",
);

// ---------------------------------------------------------------- cheers (T-509)
/** Cheers are switched off for the event (its own switch or the platform's): no moment can start. */
export const cheersOff = make(
  409,
  "cheers_off",
  "التشجيع متوقف لهذه الفعالية.",
  "Cheers are off for this event.",
);
/** A cheers moment starts only while the event is live. */
export const cheersEventNotLive = make(
  409,
  "event_not_live",
  "تبدأ لحظة التشجيع أثناء سير الفعالية فقط.",
  "A cheers moment can start only while the event is live.",
);
/** A cheer arrived with no live moment, or just after it ended. */
export const cheersNotLive = make(
  409,
  "cheers_not_live",
  "لا توجد لحظة تشجيع الآن.",
  "No cheers moment is live right now.",
);
/** `field` is reaction (not one of the five) or minutes (not 1 to 30). */
export const invalidCheer = make(
  422,
  "invalid_cheer",
  "تحقق من التشجيع أو مدة اللحظة.",
  "Check the cheer or the moment's length.",
);
