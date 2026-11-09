/**
 * Characterisation of `cleanFields`, `fieldsInUse` and `passportSteps` (function-limits split, 2026-11-09): the
 * copies below are the functions as they stood before the split, and every generated combination must give the same
 * answer (and, for the passport, the same queries) from the old and the new code.
 */
import {
  cleanOptions,
  PASSPORT_STEPS_MAX,
  type JoinFieldKind,
  type JoinOption,
} from "@questify/shared";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  fieldsInUse,
  type FieldAnswers,
  type FieldInUse,
  type FieldState,
  type TargetedItem,
} from "#src/audience/rules";
import { cleanFields, makeOptionId, type FieldInput, type FieldRecord } from "#src/join/setup";
import { passportSteps } from "#src/quests/passports";
import { bilingual, NO_TEXT, type QuestInput, type Refused } from "#src/quests/builder";
import {
  stampedSteps,
  type QuestFields,
  type QuestRecord,
  type StepInput,
} from "#src/quests/store";
import type { QuestType } from "@questify/shared";

/** Every combination of the axes' values. */
function product<T extends Record<string, readonly unknown[]>>(
  axes: T,
): { [K in keyof T]: T[K][number] }[] {
  return Object.entries(axes).reduce<Record<string, unknown>[]>(
    (rows, [key, values]) =>
      rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value }))),
    [{}],
  ) as { [K in keyof T]: T[K][number] }[];
}

// ---- cleanFields --------------------------------------------------------------------------------------------------

const JOIN_FIELD_LIMIT = 5;
const LABEL_MAX = 60;

const labelText = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

function oldOptionsOf(
  field: FieldInput,
  kept: FieldRecord | undefined,
  makeId: () => string,
): readonly JoinOption[] | null | undefined {
  if (field.options === undefined || field.options === null) {
    return null;
  }
  return field.kind === "custom"
    ? cleanOptions(field.options, kept?.options ?? [], makeId)
    : undefined;
}

function oldCleanFields(
  input: readonly FieldInput[],
  current: readonly FieldRecord[],
  makeId: () => string = makeOptionId,
): FieldRecord[] | undefined {
  if (input.length > JOIN_FIELD_LIMIT) {
    return undefined;
  }
  const kinds = new Set<JoinFieldKind>();
  const ids = new Set<string>();
  const cleaned: FieldRecord[] = [];
  for (const field of input) {
    const custom = field.kind === "custom";
    const label = custom
      ? { ar: labelText(field.label?.ar), en: labelText(field.label?.en) }
      : { ar: null, en: null };
    const kept = field.id === undefined ? undefined : current.find((row) => row.id === field.id);
    const options = oldOptionsOf(field, kept, makeId);
    if (
      options === undefined ||
      (custom && label.ar === null && label.en === null) ||
      [label.ar, label.en].some((text) => text !== null && [...text].length > LABEL_MAX) ||
      (!custom && kinds.has(field.kind)) ||
      (field.id !== undefined && (kept?.kind !== field.kind || ids.has(field.id)))
    ) {
      return undefined;
    }
    kinds.add(field.kind);
    if (field.id !== undefined) {
      ids.add(field.id);
    }
    cleaned.push({
      id: field.id ?? "",
      kind: field.kind,
      label,
      required: field.required,
      options,
    });
  }
  return cleaned;
}

const KEPT_ID = "11111111-1111-4111-8111-111111111111";
const SECTION_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_FIELDS: FieldRecord[] = [
  {
    id: KEPT_ID,
    kind: "company",
    label: { ar: null, en: null },
    required: true,
    options: null,
  },
  {
    id: SECTION_ID,
    kind: "custom",
    label: { ar: null, en: "Section" },
    required: false,
    options: [
      { id: "women", ar: null, en: "Women" },
      { id: "men", ar: null, en: "Men" },
    ],
  },
];

const FIELD_SHAPES: FieldInput[] = [
  { kind: "company", required: true },
  { kind: "company", required: false, label: { en: "ignored" } },
  { kind: "department", required: true, options: [{ en: "A" }, { en: "B" }] },
  { kind: "department", required: false, options: null },
  { id: KEPT_ID, kind: "company", required: true },
  { id: KEPT_ID, kind: "department", required: true },
  { id: "33333333-3333-4333-8333-333333333333", kind: "company", required: true },
  { kind: "custom", required: true },
  { kind: "custom", required: true, label: { ar: " ", en: "" } },
  { kind: "custom", required: true, label: { en: "Team" } },
  { kind: "custom", required: false, label: { ar: "  القسم ", en: " " }, options: null },
  { kind: "custom", required: true, label: { en: "x".repeat(60) } },
  { kind: "custom", required: true, label: { en: "x".repeat(61) } },
  { kind: "custom", required: true, label: { ar: "ب".repeat(61), en: "ok" } },
  { kind: "custom", required: true, label: { en: "X" }, options: [{ en: "A" }] },
  { kind: "custom", required: true, label: { en: "X" }, options: [{ en: "A" }, { en: "B" }] },
  {
    id: SECTION_ID,
    kind: "custom",
    required: true,
    label: { en: "Section" },
    options: [{ id: "women", en: " Ladies " }, { id: "men", ar: "رجال" }, { en: "Kids" }],
  },
  { id: SECTION_ID, kind: "custom", required: true, label: { en: "Section" }, options: null },
  { id: SECTION_ID, kind: "custom", required: true, label: { en: "Section" } },
];

function* sequences(maxLength: number): Generator<FieldInput[]> {
  const walk = function* (prefix: FieldInput[]): Generator<FieldInput[]> {
    yield prefix;
    if (prefix.length < maxLength) {
      for (const shape of FIELD_SHAPES) {
        yield* walk([...prefix, shape]);
      }
    }
  };
  yield* walk([]);
}

/** A fresh id maker: new1, new2, … */
const counter = () => {
  let n = 0;
  return () => `new${(n += 1)}`;
};

describe("cleanFields characterisation", () => {
  it("answers as before for every list of up to 2 shapes, and for lists of 5 and 6", () => {
    const lists = [
      ...sequences(2),
      FIELD_SHAPES.slice(0, 5),
      FIELD_SHAPES.slice(0, 6),
      Array.from({ length: 5 }, () => FIELD_SHAPES[9] as FieldInput),
      Array.from({ length: 6 }, () => FIELD_SHAPES[9] as FieldInput),
    ];
    let accepted = 0;
    for (const list of lists) {
      for (const current of [[], CURRENT_FIELDS]) {
        const before = oldCleanFields(list, current, counter());
        const after = cleanFields(list, current, counter());
        expect(after, JSON.stringify(list)).toStrictEqual(before);
        accepted += before === undefined ? 0 : 1;
      }
    }
    expect(accepted).toBeGreaterThan(100);
    expect(accepted).toBeLessThan(lists.length * 2);
  });
});

// ---- fieldsInUse --------------------------------------------------------------------------------------------------

type Ids = readonly JoinOption[] | null;
const idsOf = (options: Ids): string[] => (options ?? []).map((option) => option.id);

function oldFieldsInUse(
  before: readonly FieldState[],
  after: ReadonlyMap<string, Ids>,
  answers: readonly FieldAnswers[],
  targeted: readonly TargetedItem[],
): FieldInUse | undefined {
  const blocking: TargetedItem[] = [];
  let answered = false;
  for (const field of before) {
    const kept = after.has(field.id);
    const next = after.get(field.id) ?? null;
    const nextIds = new Set(idsOf(next));
    const removed = idsOf(field.options).filter((id) => !nextIds.has(id));
    for (const item of targeted) {
      const named = item.fieldId === field.id;
      if (named && (!kept || next === null || item.values.some((id) => removed.includes(id)))) {
        blocking.push(item);
      }
    }
    const given = answers.find((entry) => entry.fieldId === field.id);
    if (kept && given !== undefined) {
      const addsOptions = field.options === null && next !== null;
      answered ||= addsOptions || given.chosen.some((id) => removed.includes(id));
    }
  }
  if (blocking.length > 0) {
    const names = (kind: TargetedItem["kind"]) =>
      blocking.filter((item) => item.kind === kind).map((item) => item.name);
    return { reason: "rules", categories: names("category"), rewards: names("reward") };
  }
  return answered ? { reason: "answers" } : undefined;
}

const opt = (id: string): JoinOption => ({ id, ar: null, en: id });
const FIELD_A: FieldState = { id: "a", options: [opt("x"), opt("y")] };
const FIELD_B: FieldState = { id: "b", options: null };
const NAME = (en: string) => ({ ar: null, en });

describe("fieldsInUse characterisation", () => {
  const cases = product({
    nextA: ["deleted", null, [opt("x"), opt("y")], [opt("y")], [opt("x"), opt("z")], []] as const,
    nextB: ["deleted", null, [opt("q")]] as const,
    answerA: [undefined, [], ["x"], ["y"], ["x", "y"]] as const,
    answerB: [undefined, [], ["q"]] as const,
    items: [
      [],
      [{ kind: "category", fieldId: "a", values: ["x"] }],
      [{ kind: "reward", fieldId: "a", values: ["y"] }],
      [{ kind: "category", fieldId: "a", values: ["z"] }],
      [{ kind: "reward", fieldId: "b", values: [] }],
      [
        { kind: "category", fieldId: "b", values: [] },
        { kind: "reward", fieldId: "a", values: ["x", "y"] },
        { kind: "category", fieldId: "a", values: [] },
      ],
      [{ kind: "category", fieldId: "other", values: ["x"] }],
    ] as const,
    fields: [[FIELD_A, FIELD_B], [FIELD_A], [FIELD_B], []] as const,
  });

  it(`answers as before over ${cases.length} cases`, () => {
    const seen = new Set<string>();
    for (const c of cases) {
      const after = new Map<string, Ids>();
      if (c.nextA !== "deleted") {
        after.set("a", c.nextA as Ids);
      }
      if (c.nextB !== "deleted") {
        after.set("b", c.nextB as Ids);
      }
      const answers: FieldAnswers[] = [];
      if (c.answerA !== undefined) {
        answers.push({ fieldId: "a", chosen: c.answerA });
      }
      if (c.answerB !== undefined) {
        answers.push({ fieldId: "b", chosen: c.answerB });
      }
      const items: TargetedItem[] = c.items.map((item, index) => ({
        ...item,
        name: NAME(`item${index}`),
      }));
      const fields = c.fields as readonly FieldState[];
      const before = oldFieldsInUse(fields, after, answers, items);
      expect(fieldsInUse(fields, after, answers, items), JSON.stringify(c)).toStrictEqual(before);
      seen.add(before?.reason ?? "none");
    }
    expect([...seen].toSorted()).toEqual(["answers", "none", "rules"]);
  });
});

// ---- passportSteps ------------------------------------------------------------------------------------------------

type Checked = Readonly<{ kind: "steps"; steps: readonly StepInput[] | undefined }>;
const NOTHING: Checked = { kind: "steps", steps: undefined };

async function oldPassportSteps(
  client: PoolClient,
  current: QuestRecord | undefined,
  type: QuestType,
  fields: QuestFields,
  input: QuestInput["steps"],
): Promise<Checked | Refused> {
  if (type !== "passport") {
    return input === undefined ? NOTHING : { kind: "invalid", field: "steps" };
  }
  const steps =
    input?.map((step) => ({ id: step.id, name: bilingual(step.name, NO_TEXT) })) ??
    current?.steps.map((step) => ({ id: step.id, name: step.name }));
  if (steps === undefined || !oldWellFormed(steps, current)) {
    return { kind: "invalid", field: "steps" };
  }
  const needed = Number(fields.config["needed"]);
  if (needed > steps.length) {
    return { kind: "invalid", field: "needed" };
  }
  if (current === undefined) {
    return { kind: "steps", steps };
  }
  const stamped = await stampedSteps(client, current.id);
  if (stamped.size > 0 && needed < Number(current.config["needed"])) {
    return { kind: "invalid", field: "needed" };
  }
  const kept = new Set(steps.map((step) => step.id));
  if ([...stamped].some((id) => !kept.has(id))) {
    return { kind: "step_in_use" };
  }
  return input === undefined ? NOTHING : { kind: "steps", steps };
}

function oldWellFormed(steps: readonly StepInput[], current: QuestRecord | undefined): boolean {
  const own = new Set(current?.steps.map((step) => step.id));
  const ids = steps.flatMap((step) => (step.id === undefined ? [] : [step.id]));
  return (
    steps.length >= 1 &&
    steps.length <= PASSPORT_STEPS_MAX &&
    steps.every((step) => step.name.ar !== null || step.name.en !== null) &&
    new Set(ids).size === ids.length &&
    ids.every((id) => own.has(id))
  );
}

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";

const storedQuest = (needed: number | undefined): QuestRecord =>
  ({
    id: "44444444-4444-4444-8444-444444444444",
    config: needed === undefined ? {} : { needed },
    steps: [S1, S2, S3].map((id, position) => ({
      id,
      name: { ar: null, en: `Step ${position}` },
      position,
      qrVersion: 1,
    })),
  }) as unknown as QuestRecord;

const named = (count: number): NonNullable<QuestInput["steps"]> =>
  Array.from({ length: count }, (_, i) => ({ name: { en: `Booth ${i}` } }));

describe("passportSteps characterisation", () => {
  const cases = product({
    type: ["passport", "scan_qr"] as const,
    current: ["none", 1, 2, 3, undefined] as const,
    needed: [0, 1, 2, 3, 4, 31] as const,
    stamped: [[], [S1], [S2, S3], ["99999999-9999-4999-8999-999999999999"]] as const,
    input: [
      undefined,
      [],
      named(1),
      named(2),
      named(PASSPORT_STEPS_MAX),
      named(PASSPORT_STEPS_MAX + 1),
      [{ name: { en: "A" } }, { name: { ar: " ", en: "" } }],
      [{ name: { ar: "الأول" } }, { name: { en: "B" } }],
      [{ id: S1, name: { en: "A" } }],
      [
        { id: S1, name: { en: "A" } },
        { id: S3, name: { en: "C" } },
      ],
      [
        { id: S1, name: { en: "A" } },
        { id: S1, name: { en: "B" } },
      ],
      [{ id: S2, name: { en: "A" } }, { name: { en: "new" } }, { id: S3, name: { en: "C" } }],
      [{ id: "55555555-5555-4555-8555-555555555555", name: { en: "foreign" } }],
    ] as const,
  });

  it(`answers and queries as before over ${cases.length} cases`, async () => {
    const seen = new Set<string>();
    for (const c of cases) {
      const run = async (check: typeof passportSteps) => {
        const queries: unknown[] = [];
        const client = {
          query: async (sql: string, params: unknown[]) => {
            queries.push([sql, params]);
            return { rows: c.stamped.map((id) => ({ step_id: id })) };
          },
        } as unknown as PoolClient;
        const current =
          c.current === "none" ? undefined : storedQuest(c.current as number | undefined);
        const fields = { config: { needed: c.needed } } as unknown as QuestFields;
        const answer = await check(client, current, c.type, fields, c.input as QuestInput["steps"]);
        return { answer, queries };
      };
      const before = await run(oldPassportSteps);
      expect(await run(passportSteps), JSON.stringify(c)).toStrictEqual(before);
      const answer = before.answer as { kind: string; field?: string };
      seen.add(`${answer.kind}:${answer.field ?? ""}`);
    }
    expect([...seen].toSorted()).toEqual([
      "invalid:needed",
      "invalid:steps",
      "step_in_use:",
      "steps:",
    ]);
  });
});
