import type { ReactNode } from "react";
import { Field, Input } from "#src/ui/Field.tsx";

/**
 * A labelled number field that hands back what was typed, so a form can check it as a whole. `decimal` allows
 * fractions (a map pin), which a number input otherwise refuses to submit.
 */
export function NumberField({
  label,
  value,
  invalid,
  help,
  info,
  error,
  change,
  decimal = false,
  disabled = false,
}: Readonly<{
  label: string;
  value: number | string;
  invalid: boolean;
  /** A line under the field saying what it takes; the error replaces it while the value is wrong. */
  help?: string;
  /** An `InfoTip` beside the label, for a field that truly needs explaining (ADR-370). */
  info?: ReactNode;
  error?: string;
  change: (text: string) => void;
  decimal?: boolean;
  disabled?: boolean;
}>) {
  return (
    <Field
      label={label}
      help={invalid ? undefined : help}
      info={info}
      error={invalid ? error : undefined}
    >
      <Input
        type="number"
        inputMode={decimal ? "decimal" : "numeric"}
        {...(decimal ? { step: "any" } : {})}
        dir="ltr"
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(e) => change(e.target.value)}
      />
    </Field>
  );
}
