import type { Language } from "./digits";

export type Messages = Readonly<Record<string, Readonly<Record<Language, string>>>>;

/**
 * Every text the app and the dashboard show, in both languages. These are the shipped defaults: the app uses them
 * whenever the translation store has no value for a key or cannot be reached (FR-1768). Add a key in the same
 * change that uses it, with both languages and the same {placeholders} in each.
 */
export const MESSAGES = {
  "nav.home": { ar: "الرئيسية", en: "Home" },
  "nav.quests": { ar: "المهام", en: "Quests" },
  "nav.ranking": { ar: "الترتيب", en: "Ranking" },
  "nav.shop": { ar: "المتجر", en: "Shop" },
  "nav.profile": { ar: "حسابي", en: "Profile" },
  "common.loading": { ar: "جارٍ التحميل…", en: "Loading…" },
  "common.retry": { ar: "إعادة المحاولة", en: "Try again" },
  "error.generic": {
    ar: "حدث خطأ غير متوقع. حاول مرة أخرى.",
    en: "Something went wrong. Try again.",
  },
  "error.updateRequired": {
    ar: "يرجى تحديث التطبيق للمتابعة.",
    en: "Please update the app to continue.",
  },
  "common.cancel": { ar: "إلغاء", en: "Cancel" },
  "common.continue": { ar: "متابعة", en: "Continue" },
  "common.comingSoon": { ar: "قريبا", en: "Coming soon" },
  "settings.language": { ar: "اللغة", en: "Language" },
  "settings.restartTitle": { ar: "تغيير اللغة", en: "Change language" },
  "settings.restartBody": {
    ar: "سيُعاد تشغيل التطبيق ليظهر بالكامل باللغة الجديدة.",
    en: "The app will restart to show everything in the new language.",
  },
  "error.network": {
    ar: "تعذّر الاتصال. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.",
    en: "Could not connect. Check your connection and try again.",
  },
  "staff.dashboard": { ar: "لوحة تحكم Questify", en: "Questify dashboard" },
  "staff.signIn": { ar: "تسجيل الدخول", en: "Sign in" },
  "staff.email": { ar: "البريد الإلكتروني", en: "Email" },
  "staff.password": { ar: "كلمة المرور", en: "Password" },
  "staff.codeTitle": { ar: "أدخل رمز الدخول", en: "Enter your sign-in code" },
  "staff.codeSent": {
    ar: "أرسلنا رمزًا من 6 أرقام إلى {email}.",
    en: "We sent a 6-digit code to {email}.",
  },
  "staff.code": { ar: "رمز الدخول", en: "Sign-in code" },
  "staff.resend": { ar: "إرسال رمز جديد", en: "Send a new code" },
  "staff.resendIn": { ar: "إرسال رمز جديد ({time})", en: "Send a new code ({time})" },
  "staff.resent": { ar: "أرسلنا رمزًا جديدًا.", en: "We sent a new code." },
  "staff.otherAccount": { ar: "استخدام حساب آخر", en: "Use a different account" },
  "staff.attemptsLeft": { ar: "المحاولات المتبقية: {count}", en: "Attempts left: {count}" },
  "staff.tryAgainIn": { ar: "حاول مرة أخرى بعد {time}.", en: "Try again in {time}." },
  "staff.sessionEnded": {
    ar: "انتهت جلستك. سجّل الدخول من جديد.",
    en: "Your session has ended. Sign in again.",
  },
  "staff.signedInAs": { ar: "دخلت بحساب {email}", en: "Signed in as {email}" },
  "staff.organizers": { ar: "الجهات المنظِّمة", en: "Your organizers" },
  "staff.noOrganizers": {
    ar: "لست عضوًا في أي جهة منظِّمة بعد. اطلب من مالكها دعوتك.",
    en: "You are not part of an organizer yet. Ask its owner to invite you.",
  },
  "staff.role.owner": { ar: "مالك", en: "Owner" },
  "staff.role.editor": { ar: "محرر", en: "Editor" },
  "staff.signOut": { ar: "تسجيل الخروج", en: "Sign out" },
  "staff.signUpLink": {
    ar: "منظِّم جديد؟ أنشئ حسابًا",
    en: "New organizer? Create an account",
  },
  "staff.signUpTitle": { ar: "إنشاء حساب منظِّم", en: "Create an organizer account" },
  "staff.signInLink": { ar: "لديك حساب؟ سجّل الدخول", en: "Have an account? Sign in" },
  "staff.organizerName": { ar: "اسم الجهة المنظِّمة", en: "Organizer name" },
  "staff.organizerNameHint": {
    ar: "كما يعرفه الناس، دون روابط أو عناوين بريد.",
    en: "As people know it, without links or email addresses.",
  },
  "staff.accept.terms": { ar: "أوافق على شروط المنظِّمين", en: "I accept the organizer terms" },
  "staff.accept.dpa": {
    ar: "أوافق على اتفاقية معالجة البيانات",
    en: "I accept the data processing agreement",
  },
  "staff.accept.contentRules": {
    ar: "أوافق على قواعد المحتوى",
    en: "I accept the content rules",
  },
  "staff.readDocument": { ar: "اقرأها", en: "Read it" },
  "staff.createAccount": { ar: "إنشاء الحساب", en: "Create the account" },
  "staff.newOrganizer": { ar: "جهة منظِّمة جديدة", en: "New organizer" },
  "staff.create": { ar: "إنشاء", en: "Create" },
  "staff.team": { ar: "الفريق", en: "Team" },
  "staff.members": { ar: "الأعضاء", en: "Members" },
  "staff.allEvents": { ar: "كل الفعاليات", en: "All events" },
  "staff.chosenEvents": { ar: "فعاليات مختارة", en: "Chosen events" },
  "staff.inviteEditor": { ar: "دعوة محرر", en: "Invite an editor" },
  "staff.inviteEditorHint": {
    ar: "يبني المحرر الفعاليات ويديرها، ولا يغيّر الفريق.",
    en: "An editor builds and runs events, and cannot change the team.",
  },
  "staff.sendInvite": { ar: "إرسال الدعوة", en: "Send the invite" },
  "staff.inviteSent": { ar: "أرسلنا الدعوة.", en: "We sent the invite." },
  "staff.pendingInvites": { ar: "دعوات بانتظار القبول", en: "Invites waiting" },
  "staff.noPendingInvites": { ar: "لا دعوات بانتظار القبول.", en: "No invites waiting." },
  "staff.cancelInvite": { ar: "إلغاء الدعوة", en: "Cancel the invite" },
  "staff.remove": { ar: "إزالة", en: "Remove" },
  "staff.leave": { ar: "مغادرة الجهة المنظِّمة", en: "Leave this organizer" },
  "staff.left": { ar: "غادرت الجهة المنظِّمة.", en: "You left the organizer." },
  "staff.transferTitle": { ar: "نقل الملكية", en: "Transfer ownership" },
  "staff.transferHint": {
    ar: "أرسل دعوة ملكية إلى المالك الجديد. تصبح محررًا بعد قبوله.",
    en: "Send an owner invite to the next owner. You become an editor once they accept.",
  },
  "staff.sendOwnerInvite": { ar: "إرسال دعوة الملكية", en: "Send the owner invite" },
  "staff.inviteTitle": { ar: "دعوة إلى فريق", en: "Team invite" },
  "staff.invitedEditor": {
    ar: "دُعيت إلى فريق «{name}» محررًا.",
    en: "You are invited to join {name} as an editor.",
  },
  "staff.invitedOwner": {
    ar: "دُعيت لتصبح مالك «{name}».",
    en: "You are invited to become the owner of {name}.",
  },
  "staff.inviteFor": { ar: "الدعوة للبريد {email}.", en: "This invite is for {email}." },
  "staff.acceptInvite": { ar: "قبول الدعوة", en: "Accept the invite" },
  "staff.signInToAccept": {
    ar: "سجّل الدخول بهذا البريد لقبول الدعوة.",
    en: "Sign in with this email to accept the invite.",
  },
  "staff.newAccountPassword": {
    ar: "اختر كلمة مرور لحسابك الجديد.",
    en: "Choose a password for your new account.",
  },
  "staff.inviteOtherSignedIn": {
    ar: "أنت مسجّل بحساب آخر. سجّل الخروج ثم افتح الرابط من بريدك.",
    en: "You are signed in with another account. Sign out, then open the link from your email.",
  },
  "staff.inviteMissing": {
    ar: "افتح رابط الدعوة من بريدك مرة أخرى.",
    en: "Open the invite link from your email again.",
  },
  "staff.forgotPassword": { ar: "نسيت كلمة المرور؟", en: "Forgot your password?" },
  "staff.forgotTitle": { ar: "إعادة تعيين كلمة المرور", en: "Reset your password" },
  "staff.forgotHint": {
    ar: "أدخل بريدك الإلكتروني وسنرسل إليه رابطًا لاختيار كلمة مرور جديدة.",
    en: "Enter your email and we will send it a link to choose a new password.",
  },
  "staff.sendLink": { ar: "إرسال الرابط", en: "Send the link" },
  "staff.linkSent": {
    ar: "إذا كان لهذا البريد حساب، فقد أرسلنا إليه رابطًا يعمل لمدة 30 دقيقة.",
    en: "If an account uses this email, we sent it a link. It works for 30 minutes.",
  },
  "staff.backToSignIn": { ar: "العودة إلى تسجيل الدخول", en: "Back to sign in" },
  "staff.newPasswordTitle": { ar: "اختر كلمة مرور جديدة", en: "Choose a new password" },
  "staff.newPassword": { ar: "كلمة المرور الجديدة", en: "New password" },
  "staff.confirmPassword": {
    ar: "أعد كتابة كلمة المرور الجديدة",
    en: "Type the new password again",
  },
  "staff.passwordRules": {
    ar: "12 حرفًا على الأقل. تصلح عبارة يسهل تذكرها، دون اسم Questify أو بريدك.",
    en: "At least 12 characters. A phrase you can remember works well; leave out Questify and your email.",
  },
  "staff.passwordsDiffer": {
    ar: "كلمتا المرور غير متطابقتين.",
    en: "The two passwords do not match.",
  },
  "staff.savePassword": { ar: "حفظ كلمة المرور", en: "Save the password" },
  "staff.passwordReset": {
    ar: "حُفظت كلمة المرور الجديدة. سجّل الدخول بها.",
    en: "Your new password is saved. Sign in with it.",
  },
  "staff.linkMissing": {
    ar: "افتح الرابط من بريدك مرة أخرى، أو اطلب رابطًا جديدًا.",
    en: "Open the link from your email again, or ask for a new one.",
  },
  "staff.requestNewLink": { ar: "طلب رابط جديد", en: "Ask for a new link" },
  "staff.showPassword": { ar: "إظهار كلمة المرور", en: "Show password" },
  "staff.hidePassword": { ar: "إخفاء كلمة المرور", en: "Hide password" },
  "staff.account": { ar: "حسابي", en: "My account" },
  "staff.changePassword": { ar: "تغيير كلمة المرور", en: "Change password" },
  "staff.currentPassword": { ar: "كلمة المرور الحالية", en: "Current password" },
  "staff.passwordChanged": {
    ar: "تغيّرت كلمة المرور، وخرجنا من أجهزتك الأخرى.",
    en: "Your password is changed, and your other devices are signed out.",
  },
  "staff.weak.tooShort": {
    ar: "كلمة المرور قصيرة: استخدم 12 حرفًا على الأقل.",
    en: "Too short: use at least 12 characters.",
  },
  "staff.weak.tooLong": {
    ar: "كلمة المرور طويلة: استخدم 128 حرفًا على الأكثر.",
    en: "Too long: use at most 128 characters.",
  },
  "staff.weak.sameAsEmail": {
    ar: "لا تستخدم بريدك الإلكتروني كلمةً للمرور.",
    en: "Do not use your email as the password.",
  },
  "staff.weak.contextWord": {
    ar: "لا تضع Questify أو Nafes أو اسم بريدك في كلمة المرور.",
    en: "Leave Questify, Nafes and your email's name out of the password.",
  },
  "staff.weak.breached": {
    ar: "ظهرت كلمة المرور هذه في تسريب بيانات معروف. اختر غيرها.",
    en: "This password appeared in a known data breach. Choose another.",
  },
  "points.balance": {
    ar: "لديك {points} {currency}",
    en: "You have {points} {currency}",
  },
} as const satisfies Messages;

export type MessageKey = keyof typeof MESSAGES;
