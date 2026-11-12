// What the full demo event holds (docs/demo/PHONE_DEMO.md walks through it). Fake content only. Every item is found
// again by its English title, so a second run adds only what is missing. The Arabic follows docs/design and the
// ux-araby skill: plain Modern Standard Arabic, short, Western digits.

export const ORGANIZER_NAME = "Questify Demo Organizer";
export const EVENT_NAME = {
  ar: "عرض كويستفاي الكامل",
  en: "Questify Full Demo",
};

export const EVENT_DETAILS = {
  kind: "physical",
  venue: {
    ar: "مركز الرياض للمعارض، القاعة 3",
    en: "Riyadh Exhibition Centre, Hall 3",
  },
  access: "unlisted",
  joinMethods: ["code", "qr", "link"],
  timezone: "Asia/Riyadh",
};

/** Categories in the order the Quests tab lists them; `hidden` is revealed by its secret QR code. */
export const CATEGORIES = [
  { key: "explore", name: { ar: "استكشف المكان", en: "Explore the venue" } },
  { key: "brain", name: { ar: "ألعاب وأسئلة", en: "Games and quizzes" } },
  { key: "voice", name: { ar: "شاركنا رأيك", en: "Have your say" } },
  { key: "social", name: { ar: "تعارف ومشاركة", en: "Meet and share" } },
  {
    key: "secret",
    name: { ar: "الغرفة السرية", en: "The secret room" },
    hidden: true,
  },
];

const t = (en, ar) => ({ ar, en });
const option = (id, en, ar) => ({ id, text: t(en, ar) });

/** Entry codes the guide tells Dhia to type (they are demo data, not secrets). */
export const ENTRY_CODES = { secretWord: "FALCON", vault: "VAULT42" };

const exploreQuests = [
  {
    type: "scan_qr",
    title: t("Welcome desk", "مكتب الترحيب"),
    description: t("Scan the code at the welcome desk.", "امسح الرمز عند مكتب الترحيب."),
    points: 20,
    verification: ["quest_qr"],
  },
  {
    type: "scan_qr",
    title: t("Main stage", "المسرح الرئيسي"),
    description: t("Find the main stage and scan its code.", "اعثر على المسرح الرئيسي وامسح رمزه."),
    points: 30,
    verification: ["quest_qr"],
    mapPin: { x: 500, y: 200 },
  },
  {
    type: "scan_qr",
    title: t("Flash: coffee corner", "سريعة: ركن القهوة"),
    description: t("Shown only while the organizer runs it.", "تظهر فقط عندما يطلقها المنظم."),
    points: 40,
    verification: ["quest_qr"],
    flash: true,
  },
  {
    type: "enter_code",
    title: t("Secret word", "الكلمة السرية"),
    description: t(
      "Type the word printed on the demo sheet.",
      "اكتب الكلمة المطبوعة في ورقة العرض.",
    ),
    points: 25,
    config: {
      code: ENTRY_CODES.secretWord,
      hint: t("On the printed sheet", "في الورقة المطبوعة"),
    },
  },
  {
    type: "passport",
    title: t("Venue passport", "جواز المكان"),
    description: t(
      "Collect 3 of the 4 stamps around the venue.",
      "اجمع 3 أختام من 4 في أرجاء المكان.",
    ),
    points: 60,
    config: { needed: 3 },
    steps: [
      { name: t("Hall A", "القاعة أ") },
      { name: t("Hall B", "القاعة ب") },
      { name: t("Food court", "منطقة الطعام") },
      { name: t("Sponsor booth", "جناح الراعي") },
    ],
  },
];

const quiz = {
  type: "quiz",
  title: t("Saudi trivia", "معلومات عن السعودية"),
  description: t("Three questions, 30 seconds each.", "ثلاثة أسئلة، 30 ثانية لكل سؤال."),
  points: 15,
  config: {
    timerSeconds: 30,
    questions: [
      {
        id: "q1",
        text: t("What is the capital of Saudi Arabia?", "ما عاصمة السعودية؟"),
        choices: [
          option("a", "Riyadh", "الرياض"),
          option("b", "Jeddah", "جدة"),
          option("c", "Dammam", "الدمام"),
        ],
        right: "a",
      },
      {
        id: "q2",
        text: t(
          "How many points is this quiz worth per right answer?",
          "كم نقطة لكل إجابة صحيحة في هذا الاختبار؟",
        ),
        choices: [option("a", "5", "5"), option("b", "15", "15"), option("c", "50", "50")],
        right: "b",
      },
      {
        id: "q3",
        text: t("Which tab shows the leaderboard?", "أي تبويب يعرض الترتيب؟"),
        choices: [option("a", "Ranking", "الترتيب"), option("b", "Rewards", "الجوائز")],
        right: "a",
      },
    ],
  },
};

const game = (name, en, ar, level) => ({
  type: "game",
  title: t(en, ar),
  description: t(
    "A mini-game. Pass it once to earn the points.",
    "لعبة قصيرة. اجتزها مرة لتكسب النقاط.",
  ),
  points: 35,
  config: { game: name, level, attempts: null, cooldownMinutes: 1 },
});

const brainQuests = [
  quiz,
  game("memory_match", "Memory match", "لعبة الذاكرة", "easy"),
  game("slide_puzzle", "Slide puzzle", "أحجية الانزلاق", "easy"),
  game("catch", "Catch the stars", "التقط النجوم", "easy"),
  game("tap_rush", "Tap rush", "النقر السريع", "easy"),
];

const voiceQuests = [
  {
    type: "vote",
    title: t("Best talk of the day", "أفضل جلسة اليوم"),
    points: 10,
    config: {
      options: [
        option("ai", "AI in events", "الذكاء الاصطناعي في الفعاليات"),
        option("ux", "Design for Arabic", "التصميم للعربية"),
        option("ops", "Running a big venue", "إدارة مكان كبير"),
      ],
    },
  },
  {
    type: "vote",
    title: t("Live poll: lunch", "تصويت مباشر: الغداء"),
    description: t("The organizer sends it from the dashboard.", "يرسله المنظم من لوحة التحكم."),
    points: 10,
    config: {
      options: [
        option("kabsa", "Kabsa", "كبسة"),
        option("shawarma", "Shawarma", "شاورما"),
        option("salad", "Salad", "سلطة"),
      ],
      live: { choices: "one", results: "after_vote", minutes: 1440 },
    },
  },
  {
    type: "survey",
    title: t("Quick feedback", "رأيك باختصار"),
    points: 20,
    config: {
      questions: [
        {
          id: "s1",
          kind: "rating",
          text: t("How do you rate the event so far?", "ما تقييمك للفعالية حتى الآن؟"),
        },
        {
          id: "s2",
          kind: "choice",
          text: t("How did you hear about it?", "كيف عرفت عنها؟"),
          choices: [
            option("friend", "A friend", "صديق"),
            option("social", "Social media", "وسائل التواصل"),
            option("work", "Work", "العمل"),
          ],
        },
        {
          id: "s3",
          kind: "text",
          required: false,
          text: t("Anything we should improve?", "ما الذي نحسّنه؟"),
        },
      ],
    },
  },
  {
    type: "submission",
    title: t("Tell us your best moment", "أخبرنا بأجمل لحظة"),
    description: t("Write a sentence. The team reviews it.", "اكتب جملة. يراجعها الفريق."),
    points: 30,
    config: { accepts: ["text"], autoApprove: false, resubmit: true },
  },
  {
    type: "submission",
    title: t("Say hello", "قل مرحبًا"),
    description: t("Write anything: it is approved at once.", "اكتب أي شيء: يُقبل فورًا."),
    points: 5,
    config: { accepts: ["text"], autoApprove: true, resubmit: false },
  },
];

const socialQuests = [
  {
    type: "meet",
    title: t("Meet someone new", "تعرّف على شخص جديد"),
    description: t(
      "Show your meet code, or scan someone else's.",
      "اعرض رمز التعارف أو امسح رمز غيرك.",
    ),
    points: 15,
    repeatCap: 5,
    config: { dailyCap: 5 },
  },
  {
    type: "share",
    title: t("Invite a friend", "ادعُ صديقًا"),
    points: 10,
    config: {
      message: t("Join me at the Questify demo!", "انضم إليّ في عرض كويستفاي!"),
      link: "https://questify.nafes.com",
    },
  },
  {
    type: "challenge",
    title: t("Photo pose at the booth", "وقفة تصوير عند الجناح"),
    description: t(
      "Done in front of staff: they award it from the dashboard.",
      "تتم أمام الفريق: يمنحونك النقاط من لوحة التحكم.",
    ),
    points: 50,
    verification: ["my_qr"],
  },
];

const secretQuests = [
  {
    type: "enter_code",
    title: t("Open the vault", "افتح الخزنة"),
    description: t("The code is on the secret room's sheet.", "الرمز في ورقة الغرفة السرية."),
    points: 100,
    config: { code: ENTRY_CODES.vault },
  },
];

export const QUESTS = {
  explore: exploreQuests,
  brain: brainQuests,
  voice: voiceQuests,
  social: socialQuests,
  secret: secretQuests,
};

/** The shop's settings: where prizes are handed over, and its rules. */
export const SHOP = {
  pickupMinutes: 60,
  rules: t(
    "Collect a reserved prize at the prize desk within an hour.",
    "استلم الجائزة المحجوزة من مكتب الجوائز خلال ساعة.",
  ),
  desk: {
    location: t("Prize desk, next to the main stage", "مكتب الجوائز بجانب المسرح الرئيسي"),
  },
};

/** Shop rewards; a digital one gets `codes` (one is handed out per redemption). */
export const REWARDS = [
  {
    kind: "item",
    name: t("Questify tote bag", "حقيبة كويستفاي"),
    price: 50,
    stock: 20,
    section: "merch",
    tags: { new: true },
  },
  {
    kind: "item",
    name: t("Fresh juice", "عصير طازج"),
    price: 15,
    stock: 50,
    section: "food",
  },
  {
    kind: "experience",
    name: t("Front-row seat", "مقعد في الصف الأول"),
    price: 120,
    stock: 5,
    section: "experiences",
    tags: { limited: true },
  },
  {
    kind: "digital",
    name: t("Coffee voucher", "قسيمة قهوة"),
    description: t("Show the code at the coffee corner.", "اعرض الرمز في ركن القهوة."),
    price: 30,
    section: "featured",
    codes: Array.from({ length: 20 }, (_, i) => `DEMO-COFFEE-${String(i + 1).padStart(3, "0")}`),
  },
  {
    kind: "digital",
    name: t("Bookstore 10% off", "خصم 10% في المكتبة"),
    price: 80,
    section: "featured",
    codes: Array.from({ length: 10 }, (_, i) => `DEMO-BOOK-${String(i + 1).padStart(3, "0")}`),
  },
];

export const RANK_RULES = t(
  "The top 3 at the end of the event win. Results are confirmed by the organizer.",
  "يفوز أول 3 في نهاية الفعالية، ويعتمد المنظم النتائج.",
);

export const RANK_PRIZES = [
  {
    kind: "item",
    rankFrom: 1,
    rankTo: 1,
    name: t("Gold trophy", "الكأس الذهبية"),
  },
  {
    kind: "experience",
    rankFrom: 2,
    rankTo: 3,
    name: t("Backstage tour", "جولة خلف الكواليس"),
  },
];

export const COMMUNITY_GOAL = {
  title: t("50 quests together", "50 مهمة معًا"),
  measure: "completions",
  target: 50,
  paidTo: "everyone",
  reward: { kind: "points", points: 25 },
  milestones: [
    {
      threshold: 5,
      reward: {
        kind: "moment",
        moment: t("5 down! Keep going.", "أنجزنا 5! واصلوا."),
      },
    },
    { threshold: 20, reward: { kind: "points", points: 10 } },
  ],
};

export const MAP = {
  nameAr: "خريطة القاعة",
  nameEn: "Hall map",
  pins: [
    { kind: "section", nameEn: "Hall A", nameAr: "القاعة أ", x: 200, y: 300 },
    { kind: "section", nameEn: "Hall B", nameAr: "القاعة ب", x: 800, y: 300 },
    {
      kind: "booth",
      nameEn: "Sponsor booth",
      nameAr: "جناح الراعي",
      x: 650,
      y: 700,
    },
    { kind: "amenity", amenity: "prayer", x: 100, y: 900 },
    { kind: "amenity", amenity: "toilets", x: 900, y: 900 },
    { kind: "amenity", amenity: "food", x: 500, y: 850 },
  ],
};

/** Sponsors, each tagged on one quest or reward (by English title). */
export const SPONSORS = [
  {
    nameEn: "Falcon Coffee",
    nameAr: "قهوة الصقر",
    tier: "gold",
    booth: "B12",
    tag: { kind: "reward", title: "Coffee voucher" },
  },
  {
    nameEn: "Desert Books",
    nameAr: "كتب الصحراء",
    tier: "partner",
    tag: { kind: "quest", title: "Saudi trivia" },
  },
];

/** The Home blocks' written content (T-610). Card ids are the layout's `card:<id>` keys. */
export const homeContent = (endsAt) => ({
  banner: [
    {
      title: t("Welcome to the full demo", "أهلًا بك في العرض الكامل"),
      subtitle: t("Scan, play and win prizes", "امسح والعب واربح الجوائز"),
      action: { type: "agenda" },
    },
  ],
  quickLinks: [
    {
      label: t("Questify site", "موقع كويستفاي"),
      icon: "info",
      action: { type: "link", url: "https://questify.nafes.com" },
    },
  ],
  cards: [
    {
      id: "demotxt1",
      kind: "text",
      title: t("Doors", "الأبواب"),
      body: t(
        "Doors open at 9:00. Prayer room by Hall A.",
        "تفتح الأبواب 9:00. المصلى بجانب القاعة أ.",
      ),
    },
    {
      id: "democnt1",
      kind: "countdown",
      label: t("Demo ends", "ينتهي العرض"),
      at: endsAt,
      atZero: "message",
      message: t("The demo has ended", "انتهى العرض"),
    },
  ],
});

/** The agenda (two talks today). */
export const SESSIONS = [
  { title: t("Opening keynote", "الكلمة الافتتاحية"), startHour: 10 },
  { title: t("Design for Arabic", "التصميم للعربية"), startHour: 13 },
];

/** Five-letter daily words, one per day (the console's word bank). */
export const DAILY_WORDS = {
  en: ["QUEST", "PRIZE", "SCORE", "BADGE", "CROWN", "MEDAL", "MAGIC"],
  ar: ["جوائز", "رحلات", "فرسان", "خرائط", "ألعاب", "أبطال", "مدينة"],
};
