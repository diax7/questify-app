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
  "أُزيل هذا اللاعب من الفعالية، فلا يمكن حظره أو رفع الحظر عنه.",
  "This player was removed from the event, so they cannot be banned or unbanned.",
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
  "لا يمكن أن تقل الكمية عن المحجوز منها.",
  "The stock cannot be lower than the units already reserved.",
);
export const shopClosed = make(
  403,
  "shop_closed",
  "متجر الجوائز مغلق الآن.",
  "The rewards shop is closed right now.",
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
