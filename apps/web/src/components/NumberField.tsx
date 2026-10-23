import styles from "#src/components/layout.module.css";

/**
 * A labelled number field that hands back what was typed, so a form can check it as a whole. `decimal` allows
 * fractions (a map pin), which a number input otherwise refuses to submit.
 */
export function NumberField({
  label,
  value,
  invalid,
  change,
  decimal = false,
  disabled = false,
}: Readonly<{
  label: string;
  value: number | string;
  invalid: boolean;
  change: (text: string) => void;
  decimal?: boolean;
  disabled?: boolean;
}>) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        className={styles.input}
        type="number"
        inputMode={decimal ? "decimal" : "numeric"}
        {...(decimal ? { step: "any" } : {})}
        dir="ltr"
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
}
