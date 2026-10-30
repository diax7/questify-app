"use client";

import { PASSPORT_STEPS_MAX } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import {
  TextPair,
  newItem,
  type Item,
  type TypeFieldProps,
} from "#src/components/QuestTextFields.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Field, FieldGroup, Input } from "#src/ui/Field.tsx";

/** A passport step in the form: a saved one keeps its id for the API, a new one gets a local id only. */
export type StepItem = Item & Readonly<{ saved?: boolean }>;

const stepsOf = (value: unknown): readonly StepItem[] =>
  Array.isArray(value) ? (value as StepItem[]) : [newItem()];

/**
 * A passport's steps and how many a player must stamp (T-304b, FR-224). Each step gets its own printed code on the
 * codes page; a step players stamped can be renamed but not removed (the API says so).
 */
export function PassportFields({ language, config, disabled, change }: TypeFieldProps) {
  const t = translatorFor(language);
  const steps = stepsOf(config["steps"]);
  const needed = typeof config["needed"] === "number" ? config["needed"] : 1;
  const save = (next: readonly StepItem[]) => change({ ...config, steps: next });
  return (
    <FieldGroup legend={t("quests.passport.steps")}>
      <Field label={t("quests.passport.needed")}>
        <Input
          type="number"
          inputMode="numeric"
          dir="ltr"
          min={1}
          required
          value={needed}
          disabled={disabled}
          onChange={(event) => change({ ...config, needed: Number(event.target.value) })}
        />
      </Field>
      {steps.map((step, index) => (
        <FieldGroup key={step.id}>
          <TextPair
            labels={{
              ar: t("quests.passport.stepAr", { number: index + 1 }),
              en: t("quests.passport.stepEn", { number: index + 1 }),
            }}
            text={step.text}
            max={120}
            disabled={disabled}
            change={(text) =>
              save(steps.map((one) => (one.id === step.id ? { ...one, text } : one)))
            }
          />
          {steps.length > 1 ? (
            <Button
              variant="quiet"

              disabled={disabled}
              onClick={() => save(steps.filter((one) => one.id !== step.id))}
            >
              {t("quests.passport.removeStep", { number: index + 1 })}
            </Button>
          ) : null}
        </FieldGroup>
      ))}
      {steps.length < PASSPORT_STEPS_MAX ? (
        <Button
          variant="quiet"

          disabled={disabled}
          onClick={() => save([...steps, newItem()])}
        >
          {t("quests.passport.addStep")}
        </Button>
      ) : null}
    </FieldGroup>
  );
}
