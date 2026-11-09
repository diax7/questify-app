/**
 * Direct cases of `full_name_stems(forms, arabic)` (migration 0186): the forms of one word in, the stems with one affix
 * removed out (`stems`), and the Arabic ones an allow word covers (`named`: the prefix and nisba forms, never after يا).
 * Stems come in the order the function loops: form, then prefix, then ending, each in its list's order. Plain data, so the
 * test file reads it and nothing else does.
 */
export type StemCase = Readonly<{
  forms: readonly string[];
  arabic: boolean;
  stems: readonly string[];
  /** The Arabic stems an allow word covers; none for a Latin word. */
  named: readonly string[];
}>;

export type StemRule = Readonly<{ rule: string; cases: readonly StemCase[] }>;

const ar = (forms: string[], stems: string[], named: string[]): StemCase => ({
  forms,
  arabic: true,
  stems,
  named,
});
const en = (forms: string[], stems: string[]): StemCase => ({
  forms,
  arabic: false,
  stems,
  named: [],
});

export const STEM_RULES: readonly StemRule[] = [
  {
    rule: "takes ال and وال off an Arabic word, and the و alone",
    cases: [
      ar(["الخول"], ["الخول", "خول"], ["الخول", "خول"]),
      ar(["والخول"], ["والخول", "الخول", "خول"], ["والخول", "الخول", "خول"]),
    ],
  },
  {
    rule: "reads ة as ه before a pronoun ending or ات, and not before any other ending",
    cases: [
      ar(["خولتك"], ["خولتك", "خولت", "خول", "خوله"], ["خولتك"]),
      ar(["خولتي"], ["خولتي", "خول", "خوله", "خولت"], ["خولتي", "خولت"]),
      ar(["خولات"], ["خولات", "خول", "خوله"], ["خولات"]),
      ar(["خولها"], ["خولها", "خول"], ["خولها"]),
      ar(["خولون"], ["خولون", "خول"], ["خولون"]),
    ],
  },
  {
    rule: "takes the nisba endings ي, يه and ه off, and names the stem",
    cases: [
      ar(["خولي"], ["خولي", "خول"], ["خولي", "خول"]),
      ar(["خوليه"], ["خوليه", "خول", "خولي"], ["خوليه", "خول", "خولي"]),
      ar(["خوله"], ["خوله", "خول"], ["خوله", "خول"]),
      ar(["بخولي"], ["بخولي", "بخول", "خولي", "خول"], ["بخولي", "بخول", "خولي", "خول"]),
    ],
  },
  {
    rule: "never names a stem after يا (a call), though it still gives it as a stem",
    cases: [
      ar(["ياخولي"], ["ياخولي", "ياخول", "خولي", "خول"], ["ياخولي", "ياخول"]),
      ar(["ياخوله"], ["ياخوله", "ياخول", "خوله", "خول"], ["ياخوله", "ياخول"]),
      ar(
        ["ياالخولي"],
        ["ياالخولي", "ياالخول", "الخولي", "الخول", "خولي", "خول"],
        ["ياالخولي", "ياالخول"],
      ),
    ],
  },
  {
    rule: "keeps 2 letters or more of an Arabic stem, after an ending and after a prefix",
    cases: [
      ar(["خوي"], ["خوي", "خو"], ["خوي", "خو"]),
      ar(["خي"], ["خي"], ["خي"]),
      ar(["الخو"], ["الخو", "خو"], ["الخو", "خو"]),
      ar(["الخ"], ["الخ"], ["الخ"]),
    ],
  },
  {
    rule: "takes s, es, er, ers, ed, ing, ings and y off a Latin word",
    cases: [
      en(["cats"], ["cats", "cat"]),
      en(["boxes"], ["boxes", "boxe", "box"]),
      en(["bigger"], ["bigger", "bigg"]),
      en(["biggers"], ["biggers", "bigger", "bigg"]),
      en(["baked"], ["baked", "bak"]),
      en(["baking"], ["baking", "bak"]),
      en(["bakings"], ["bakings", "baking", "bak"]),
      en(["party"], ["party", "part"]),
    ],
  },
  {
    rule: "reads a Latin -ies stem as y as well",
    cases: [en(["cities"], ["cities", "citie", "citi", "cit", "city"])],
  },
  {
    rule: "keeps 2 letters or more of a Latin stem",
    cases: [en(["abs"], ["abs", "ab"]), en(["as"], ["as"]), en(["ab"], ["ab"])],
  },
  {
    rule: "reads only the lists of its script, and every form in order",
    cases: [
      en(["الخولي"], ["الخولي"]),
      ar(["cats"], ["cats"], ["cats"]),
      en(["cats", "dogs"], ["cats", "cat", "dogs", "dog"]),
    ],
  },
  {
    rule: "gives no stem for an empty input or one letter, in either script",
    cases: [
      en([], []),
      ar([], [], []),
      en([""], []),
      ar([""], [], []),
      en(["a"], []),
      ar(["خ"], [], []),
    ],
  },
];
