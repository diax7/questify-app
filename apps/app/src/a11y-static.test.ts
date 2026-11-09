import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

/**
 * T-808, the part that can be checked from the code (the rest needs a phone and a screen reader). Every .tsx file of
 * the player app is parsed and five things are enforced:
 *
 *  1. A touchable (Pressable, the Touchable* family, a Switch, a lowercase `button`) has an accessibilityRole and an
 *     accessible name: an accessibilityLabel, or a text child.
 *  2. An Image that is not decorative has an accessibilityLabel (decorative: accessible={false},
 *     importantForAccessibility="no" or "no-hide-descendants", accessibilityElementsHidden, aria-hidden), or sits
 *     inside a touchable that is named and groups it for a screen reader.
 *  3. A TextInput has an accessibilityLabel (or aria-label / accessibilityLabelledBy).
 *  4. An Ionicons glyph is hidden from a screen reader or sits inside a named touchable or labelled element.
 *  5. No hard-coded user-facing string: text in JSX and the text-carrying props go through the translator `t(...)`.
 *
 * The parser is @babel/parser (the app's own dependency, also used by hermes-runtime.test.ts) and not the TypeScript
 * compiler API: the installed TypeScript 7 is the native compiler and has no stable in-process syntax-tree API.
 */

const APP_ROOT = join(import.meta.dirname, "..");
const ROOTS = [join(APP_ROOT, "src"), join(APP_ROOT, "app")];

const TOUCHABLES = new Set([
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "TouchableNativeFeedback",
  "Switch",
  "button",
]);
/** Components that draw their text themselves; a touchable holding one has a name. */
const TEXT_COMPONENTS = new Set(["Text", "AppText"]);
/** Props that carry text a person reads or hears. */
const TEXT_PROPS = new Set([
  "label",
  "title",
  "placeholder",
  "accessibilityLabel",
  "accessibilityHint",
  "aria-label",
  "info",
  "subject",
  "message",
  "hint",
  "caption",
  "subtitle",
  "text",
]);
const NAME_PROPS = [
  "accessibilityLabel",
  "aria-label",
  "accessibilityLabelledBy",
  "aria-labelledby",
];

type Kind =
  | "touchable-name"
  | "touchable-role"
  | "image-label"
  | "input-label"
  | "icon-hidden"
  | "hard-coded-text";

/**
 * Places that are allowed to break a rule, each with the reason. Matched by file (relative to apps/app), kind and
 * the offending text (or the element name for the structural kinds). A stale entry fails the test.
 */
type Allowed = Readonly<{ file: string; kind: Kind; match: string; reason: string }>;
const ALLOW: readonly Allowed[] = [];

type Issue = Readonly<{ file: string; line: number; kind: Kind; match: string }>;

// Babel's node types are loose on purpose here: the checks read a handful of fields.
type Node = {
  type: string;
  loc?: { start: { line: number } } | null;
  // The fields the checks read; each node type has some of them.
  name?: any;
  object?: any;
  property?: any;
  attributes?: any;
  value?: any;
  children?: any;
  openingElement?: any;
  expression?: any;
  expressions?: any;
  quasis?: any;
  consequent?: any;
  alternate?: any;
  left?: any;
  right?: any;
} & Record<string, any>;

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
      continue;
    }
    if (Array.isArray(value)) {
      out.push(...value.filter(isNode));
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function elementName(opening: Node): string {
  const name = opening.name as Node;
  if (name.type === "JSXIdentifier") {
    return name.name as string;
  }
  if (name.type === "JSXMemberExpression") {
    return elementNameOfMember(name);
  }
  return "";
}

function elementNameOfMember(name: Node): string {
  const object = name.object as Node;
  const head =
    object.type === "JSXIdentifier" ? (object.name as string) : elementNameOfMember(object);
  return `${head}.${(name.property as Node).name as string}`;
}

function attribute(opening: Node, name: string): Node | undefined {
  return (opening.attributes as Node[]).find(
    (attr) => attr.type === "JSXAttribute" && (attr.name as Node).name === name,
  );
}

/** The static value of an attribute: "true" for a bare one, the literal text, or null when it is computed. */
function attributeValue(attr: Node): string | null {
  const value = attr.value as Node | null;
  if (value === null) {
    return "true";
  }
  if (value.type === "StringLiteral") {
    return value.value as string;
  }
  if (value.type === "JSXExpressionContainer") {
    const expression = value.expression as Node;
    if (expression.type === "BooleanLiteral") {
      return String(expression.value);
    }
    if (expression.type === "StringLiteral") {
      return expression.value as string;
    }
  }
  return null;
}

function isDecorative(opening: Node): boolean {
  const accessible = attribute(opening, "accessible");
  const important = attribute(opening, "importantForAccessibility");
  const hidden =
    attribute(opening, "accessibilityElementsHidden") ?? attribute(opening, "aria-hidden");
  return (
    (accessible !== undefined && attributeValue(accessible) === "false") ||
    (important !== undefined &&
      ["no", "no-hide-descendants"].includes(attributeValue(important) ?? "")) ||
    (hidden !== undefined && attributeValue(hidden) !== "false")
  );
}

function hasName(opening: Node): boolean {
  return NAME_PROPS.some((prop) => {
    const attr = attribute(opening, prop);
    return attr !== undefined && attributeValue(attr) !== "";
  });
}

/** Whether an element's children hold text: a Text or AppText, or literal text. */
function holdsText(element: Node): boolean {
  return (element.children as Node[]).some((child) => {
    if (child.type === "JSXText") {
      return /\S/.test(child.value as string);
    }
    if (child.type === "JSXElement") {
      return (
        TEXT_COMPONENTS.has(elementName(child.openingElement as Node)) ||
        hasName(child.openingElement as Node) ||
        holdsText(child)
      );
    }
    return child.type === "JSXExpressionContainer" && expressionHoldsText(child.expression as Node);
  });
}

/** Text inside `{cond && <AppText/>}`, `{list.map(() => <AppText/>)}` and a Pressable's render function. */
function expressionHoldsText(node: Node): boolean {
  if (node.type === "JSXElement") {
    return TEXT_COMPONENTS.has(elementName(node.openingElement as Node)) || holdsText(node);
  }
  return children(node).some(expressionHoldsText);
}

/** The string literals an expression can produce: through `?:`, `&&`, `||`, `??`, parentheses and `as`. */
function stringLeaves(node: Node): Node[] {
  switch (node.type) {
    case "StringLiteral":
      return [node];
    case "TemplateLiteral":
      return (node.expressions as Node[]).length === 0 ? [node] : [];
    case "ConditionalExpression":
      return [...stringLeaves(node.consequent as Node), ...stringLeaves(node.alternate as Node)];
    case "LogicalExpression":
      return [...stringLeaves(node.left as Node), ...stringLeaves(node.right as Node)];
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
      return stringLeaves(node.expression as Node);
    default:
      return [];
  }
}

function literalText(node: Node): string {
  return node.type === "TemplateLiteral"
    ? (((node.quasis as Node[])[0]?.value as { cooked: string } | undefined)?.cooked ?? "")
    : (node.value as string);
}

const HAS_LETTER = /\p{L}/u;
/** A message key passed to a component that translates it, such as title="operator.award.title". */
const MESSAGE_KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/;

function textIssues(element: Node, file: string): Issue[] {
  const found: Issue[] = [];
  const add = (node: Node, text: string) => {
    if (HAS_LETTER.test(text) && !MESSAGE_KEY.test(text.trim())) {
      found.push({
        file,
        line: node.loc?.start.line ?? 0,
        kind: "hard-coded-text",
        match: text.trim(),
      });
    }
  };
  for (const child of element.children as Node[]) {
    if (child.type === "JSXText") {
      add(child, child.value as string);
    } else if (child.type === "JSXExpressionContainer") {
      for (const leaf of stringLeaves(child.expression as Node)) {
        add(leaf, literalText(leaf));
      }
    }
  }
  for (const attr of (element.openingElement as Node).attributes as Node[]) {
    if (attr.type !== "JSXAttribute" || !TEXT_PROPS.has((attr.name as Node).name as string)) {
      continue;
    }
    const value = attr.value as Node | null;
    if (value?.type === "StringLiteral") {
      add(value, value.value as string);
    } else if (value?.type === "JSXExpressionContainer") {
      for (const leaf of stringLeaves(value.expression as Node)) {
        add(leaf, literalText(leaf));
      }
    }
  }
  return found;
}

function structureIssues(element: Node, file: string, groupedByTouchable: boolean): Issue[] {
  const opening = element.openingElement as Node;
  const name = elementName(opening);
  const line = opening.loc?.start.line ?? 0;
  const issue = (kind: Kind): Issue => ({ file, line, kind, match: name });
  const found: Issue[] = [];
  if (TOUCHABLES.has(name) && !isDecorative(opening)) {
    // A Switch has its own native role.
    if (
      name !== "button" &&
      name !== "Switch" &&
      attribute(opening, "accessibilityRole") === undefined &&
      attribute(opening, "role") === undefined
    ) {
      found.push(issue("touchable-role"));
    }
    if (!hasName(opening) && !holdsText(element)) {
      found.push(issue("touchable-name"));
    }
  }
  if (
    (name === "Image" || name.endsWith(".Image")) &&
    !isDecorative(opening) &&
    !hasName(opening) &&
    !groupedByTouchable
  ) {
    if (attribute(opening, "alt") === undefined) {
      found.push(issue("image-label"));
    }
  }
  // A glyph font icon is text to a screen reader: it needs a named parent, or to be hidden.
  if (name === "Ionicons" && !isDecorative(opening) && !groupedByTouchable) {
    found.push(issue("icon-hidden"));
  }
  if (name === "TextInput" && !hasName(opening)) {
    found.push(issue("input-label"));
  }
  return found;
}

/**
 * Whether an element hides what is inside it from a screen reader, or makes it one focus stop with its own name (a named
 * touchable, or an `accessible` element with a label): the images inside it are then not read on their own.
 */
function groupsDescendants(element: Node): boolean {
  const opening = element.openingElement as Node;
  const accessible = attribute(opening, "accessible");
  const important = attribute(opening, "importantForAccessibility");
  const hidesDescendants =
    attribute(opening, "accessibilityElementsHidden") !== undefined ||
    attribute(opening, "aria-hidden") !== undefined ||
    (important !== undefined && attributeValue(important) === "no-hide-descendants");
  const oneStop =
    hasName(opening) && (accessible === undefined ? false : attributeValue(accessible) === "true");
  const namedTouchable =
    TOUCHABLES.has(elementName(opening)) && (hasName(opening) || holdsText(element));
  return hidesDescendants || oneStop || namedTouchable;
}

function walk(node: Node, file: string, groupedByTouchable: boolean, out: Issue[]): void {
  let grouped = groupedByTouchable;
  if (node.type === "JSXElement") {
    out.push(...structureIssues(node, file, groupedByTouchable), ...textIssues(node, file));
    if (groupsDescendants(node)) {
      grouped = true;
    }
  }
  for (const child of children(node)) {
    walk(child, file, grouped, out);
  }
}

function scanApp(): Issue[] {
  const out: Issue[] = [];
  for (const root of ROOTS) {
    for (const path of sourceFiles(root)) {
      const ast = parse(readFileSync(path, "utf8"), {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      }) as unknown as Node;
      walk(ast, relative(APP_ROOT, path), false, out);
    }
  }
  return out;
}

function isAllowed(issue: Issue): boolean {
  return ALLOW.some(
    (entry) =>
      entry.file === issue.file && entry.kind === issue.kind && entry.match === issue.match,
  );
}

describe("player app accessibility, from the code (T-808)", () => {
  const issues = scanApp();

  it("scans the app's screens and components", () => {
    // A guard against the scan silently finding nothing (a moved folder, a parser change).
    expect(sourceFiles(join(APP_ROOT, "src")).length).toBeGreaterThan(100);
    expect(sourceFiles(join(APP_ROOT, "app")).length).toBeGreaterThan(30);
  });

  it("finds no unnamed touchable, unlabelled image or input, or hard-coded text outside the allow list", () => {
    const open = issues.filter((issue) => !isAllowed(issue));
    expect(
      open.map(
        (issue) => `${issue.file}:${issue.line} ${issue.kind} ${JSON.stringify(issue.match)}`,
      ),
    ).toEqual([]);
  });

  it("keeps no stale allow-list entry, and gives every entry a reason", () => {
    for (const entry of ALLOW) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(
        issues.some(
          (issue) => isAllowed(issue) && issue.file === entry.file && issue.match === entry.match,
        ),
        `${entry.file} ${entry.kind} ${entry.match}`,
      ).toBe(true);
    }
  });
});

function check(source: string): Kind[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  }) as unknown as Node;
  const out: Issue[] = [];
  walk(ast, "x.tsx", false, out);
  return out.map((issue) => issue.kind);
}

describe("the checker itself", () => {
  it("flags a touchable with no role and no name", () => {
    expect(check("const a = <Pressable onPress={go}><Icon /></Pressable>;")).toEqual([
      "touchable-role",
      "touchable-name",
    ]);
  });

  it("accepts a touchable with a role and a label or a text child", () => {
    expect(
      check('const a = <Pressable accessibilityRole="button" accessibilityLabel={t("a")} />;'),
    ).toEqual([]);
    expect(
      check(
        'const a = <Pressable accessibilityRole="button"><AppText>{t("a")}</AppText></Pressable>;',
      ),
    ).toEqual([]);
  });

  it("flags an unlabelled image and accepts a decorative or labelled one", () => {
    expect(check("const a = <Image source={s} />;")).toEqual(["image-label"]);
    expect(check("const a = <Image source={s} accessible={false} />;")).toEqual([]);
    expect(check('const a = <Image source={s} importantForAccessibility="no" />;')).toEqual([]);
    expect(check("const a = <Image source={s} accessibilityElementsHidden />;")).toEqual([]);
    expect(check('const a = <Image source={s} accessibilityLabel={t("a")} />;')).toEqual([]);
  });

  it("flags an unlabelled input", () => {
    expect(check("const a = <TextInput value={v} />;")).toEqual(["input-label"]);
    expect(check('const a = <TextInput accessibilityLabel={t("a")} />;')).toEqual([]);
  });

  it("lets a named or hiding parent cover the images and icons inside it", () => {
    const named =
      '<Pressable accessibilityRole="button" accessibilityLabel={t("a")}><Image source={s} /><Ionicons name="x" /></Pressable>';
    expect(check(`const a = ${named};`)).toEqual([]);
    const hidden =
      '<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Image source={s} /><Ionicons name="x" /></View>';
    expect(check(`const a = ${hidden};`)).toEqual([]);
    const labelled = '<View accessible accessibilityLabel={t("a")}><Image source={s} /></View>';
    expect(check(`const a = ${labelled};`)).toEqual([]);
    expect(
      check('const a = <View accessibilityLabel={t("a")}><Image source={s} /></View>;'),
    ).toEqual(["image-label"]);
  });

  it("flags an icon glyph that is neither hidden nor inside a named parent", () => {
    expect(check('const a = <Ionicons name="flag" />;')).toEqual(["icon-hidden"]);
    expect(
      check(
        'const a = <Ionicons name="flag" accessible={false} importantForAccessibility="no" />;',
      ),
    ).toEqual([]);
  });

  it("needs a label on a Switch but not a role, and skips message keys", () => {
    expect(check("const a = <Switch value={v} />;")).toEqual(["touchable-name"]);
    expect(check('const a = <Switch value={v} accessibilityLabel={t("a")} />;')).toEqual([]);
    expect(check('const a = <Screen title="operator.award.title" />;')).toEqual([]);
  });

  it("flags hard-coded text in children and props, through a conditional", () => {
    expect(check("const a = <AppText>Hello</AppText>;")).toEqual(["hard-coded-text"]);
    expect(check('const a = <AppText>{ok ? "Yes" : t("no")}</AppText>;')).toEqual([
      "hard-coded-text",
    ]);
    expect(check('const a = <Button label="Save" onPress={go} />;')).toEqual(["hard-coded-text"]);
    expect(check('const a = <AppText>{t("a")}</AppText>;')).toEqual([]);
    expect(check('const a = <AppText>{1}{" · "}</AppText>;')).toEqual([]);
  });
});
