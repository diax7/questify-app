"use client";

import {
  createContext,
  type ComponentProps,
  type FormHTMLAttributes,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import styles from "#src/ui/form.module.css";

type FieldWiring = Readonly<{ id: string; describedBy: string | undefined; invalid: boolean }>;

const FieldContext = createContext<FieldWiring | null>(null);

const join = (...names: (string | false | undefined)[]): string =>
  names.filter((name) => typeof name === "string" && name !== "").join(" ");

/**
 * One labelled form field: the label, the control (an `Input`, `Select` or `Textarea` placed inside), then its help
 * and its error. The control is tied to the label, the help and the error without ids written by hand.
 */
export function Field({
  id: fixedId,
  label,
  help,
  error,
  children,
}: Readonly<{
  /** A fixed id for the control, when other code finds it (to focus the field a refusal names). */
  id?: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}>) {
  const ownId = useId();
  const id = fixedId ?? ownId;
  const hasHelp = present(help);
  const hasError = present(error);
  const describedBy = join(hasHelp && `${id}-help`, hasError && `${id}-error`) || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <FieldContext.Provider value={{ id, describedBy, invalid: hasError }}>
        {children}
      </FieldContext.Provider>
      <FieldNote id={`${id}-help`} className={styles.help} text={help} />
      <FieldNote id={`${id}-error`} className={styles.error} text={error} />
    </div>
  );
}

/** Whether an optional piece of content is there to show. */
const present = (node: ReactNode): boolean => node !== undefined && node !== null && node !== false;

/** A field's help or error line, when it has one. */
function FieldNote({
  id,
  className,
  text,
}: Readonly<{ id: string; className: string; text: ReactNode }>) {
  return present(text) ? (
    <p id={id} className={className}>
      {text}
    </p>
  ) : null;
}

/** The id, description and invalid state a control inside a `Field` takes, unless it sets its own. */
function useWiring(props: Readonly<{ "aria-invalid"?: unknown }>) {
  const field = useContext(FieldContext);
  return {
    id: field?.id,
    "aria-describedby": field?.describedBy,
    ...(field?.invalid === true && props["aria-invalid"] === undefined
      ? { "aria-invalid": true }
      : {}),
  };
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...useWiring(props)} {...props} className={join(styles.control, className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...useWiring(props)} {...props} className={join(styles.control, className)} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      {...useWiring(props)}
      {...props}
      className={join(styles.control, styles.textarea, className)}
    />
  );
}

type ChoiceProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> &
  Readonly<{ label: ReactNode; help?: ReactNode }>;

function Choice({
  type,
  look,
  label,
  help,
  ...props
}: ChoiceProps & Readonly<{ type: "checkbox" | "radio"; look: string }>) {
  const id = useId();
  const hasHelp = present(help);
  return (
    <label className={join(styles.choice, look)}>
      <input type={type} {...(hasHelp ? { "aria-describedby": `${id}-help` } : {})} {...props} />
      <span className={styles.choiceText}>
        <span>{label}</span>
        {hasHelp ? (
          <span id={`${id}-help`} className={styles.help}>
            {help}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function Checkbox(props: ChoiceProps) {
  return <Choice type="checkbox" look="" {...props} />;
}

export function Radio(props: ChoiceProps) {
  return <Choice type="radio" look="" {...props} />;
}

/** An on/off setting that saves at once. Drawn as a toggle; still a checkbox to a screen reader. */
export function Switch(props: ChoiceProps) {
  return <Choice type="checkbox" look={styles.switch} {...props} />;
}

/**
 * Related fields under one legend. `columns` puts them side by side when there is room (an Arabic and an English
 * name); `choices` lays out a set of checkboxes or radios.
 */
export function FieldGroup({
  legend,
  help,
  layout = "stack",
  disabled,
  children,
}: Readonly<{
  legend?: ReactNode;
  help?: ReactNode;
  layout?: "stack" | "columns" | "choices" | "choiceGrid";
  /** Disables every control inside at once (a form while it saves). */
  disabled?: boolean;
  children: ReactNode;
}>) {
  const inner = {
    stack: styles.group,
    columns: styles.columns,
    choices: styles.choiceList,
    choiceGrid: styles.choiceGrid,
  }[layout];
  const body = layout === "stack" ? children : <div className={inner}>{children}</div>;
  const helpText = help === undefined ? null : <p className={styles.help}>{help}</p>;
  if (legend === undefined && disabled === undefined) {
    return (
      <div className={styles.group}>
        {body}
        {helpText}
      </div>
    );
  }
  return (
    <fieldset className={styles.group} disabled={disabled}>
      {legend === undefined ? null : <legend className={styles.legend}>{legend}</legend>}
      {helpText}
      {body}
    </fieldset>
  );
}

/** A text field with a control of its own beside it (show a password). */
export function InlineControls({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={styles.inline}>{children}</div>;
}

/** A form whose fields and buttons stack with the standard gap; `card` draws it as a box of its own. */
export function Form({
  card = false,
  className,
  ...props
}: FormHTMLAttributes<HTMLFormElement> & Readonly<{ card?: boolean }>) {
  return <form {...props} className={join(styles.group, card && styles.formCard, className)} />;
}
export const codeInputClass: string = styles.codeInput;
