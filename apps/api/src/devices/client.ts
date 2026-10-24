/** Browsers, most specific first: Edge and Opera also say Chrome, and Chrome also says Safari. */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\b(?:OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

/** Systems, most specific first: a TV or an iPad before the system it runs on. */
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:Tizen|Web0S|webOS|SMART-TV|SmartTV|BRAVIA|AFT[A-Z])/i, "a TV"],
  [/\biPad\b/, "iPadOS"],
  [/\b(?:iPhone|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const first = (agent: string, table: ReadonlyArray<readonly [RegExp, string]>): string | null =>
  table.find(([pattern]) => pattern.test(agent))?.[1] ?? null;

/**
 * What a pairing page's User-Agent says, reduced to a browser and a system name ("Chrome on Android"), so staff can tell
 * the screen in front of them (ADR-239). Never a version, a model or anything else: at most 60 characters of fixed
 * words, empty when nothing is known.
 */
export function clientOf(agent: string | undefined): string {
  if (agent === undefined) {
    return "";
  }
  const browser = first(agent, BROWSERS);
  const system = first(agent, SYSTEMS);
  if (browser !== null && system !== null) {
    return `${browser} on ${system}`;
  }
  return browser ?? system ?? "";
}
