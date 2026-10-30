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
import { nameInfo } from "#src/ui/name-info.ts";

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
  info,
  error,
  children,
}: Readonly<{
  /** A fixed id for the control, when other code finds it (to focus the field a refusal names). */
  id?: string;
  label: ReactNode;
  /** A rule the user must meet, said once and briefly. A line that only repeats the label is cut instead. */
  help?: ReactNode;
  /** An `InfoTip` beside the label, for a field that truly needs explaining (ADR-370). */
  info?: ReactNode;
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
      <FieldLabel id={id} label={label} info={info} />
      <FieldContext.Provider value={{ id, describedBy, invalid: hasError }}>
        {children}
      </FieldContext.Provider>
      <FieldNote id={`${id}-help`} className={styles.help} text={help} />
      <FieldNote id={`${id}-error`} className={styles.error} text={error} role="alert" />
    </div>
  );
}

/** A field's label, with its info button beside it when it has one. */
function FieldLabel({
  id,
  label,
  info,
}: Readonly<{ id: string; label: ReactNode; info: ReactNode }>) {
  const text = (
    <label className={styles.label} htmlFor={id}>
      {label}
    </label>
  );
  return present(info) ? (
    <div className={styles.labelRow}>
      {text}
      {nameInfo(info, label)}
    </div>
  ) : (
    text
  );
}

/** Whether an optional piece of content is there to show. */
const present = (node: ReactNode): boolean => node !== undefined && node !== null && node !== false;

/** A field's help or error line, when it has one. */
function FieldNote({
  id,
  className,
  text,
  role,
}: Readonly<{ id: string; className: string; text: ReactNode; role?: "alert" }>) {
  return present(text) ? (
    <p id={id} className={className} role={role}>
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

/** A text field; `code` draws it as a one-time code: large, spaced digits. */
export function Input({
  className,
  code = false,
  ...props
}: ComponentProps<"input"> & Readonly<{ code?: boolean }>) {
  return (
    <input
      {...useWiring(props)}
      {...props}
      className={join(styles.control, code && styles.codeInput, className)}
    />
  );
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
  Readonly<{ label: ReactNode; help?: ReactNode; info?: ReactNode }>;

function Choice({
  type,
  look,
  label,
  help,
  info,
  ...props
}: ChoiceProps & Readonly<{ type: "checkbox" | "radio"; look: string }>) {
  const id = useId();
  const hasHelp = present(help);
  const choice = (
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
  return present(info) ? (
    <div className={styles.choiceRow}>
      {choice}
      {nameInfo(info, label)}
    </div>
  ) : (
    choice
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
 * A group's fieldset and its legend. With an info button the legend text carries an id the fieldset is named by, so the
 * button does not become part of the group's name.
 */
function GroupFieldset({
  legend,
  info,
  disabled,
  children,
}: Readonly<{
  legend: ReactNode;
  info: ReactNode;
  disabled: boolean | undefined;
  children: ReactNode;
}>) {
  const legendId = useId();
  const named = legend !== undefined && present(info);
  return (
    <fieldset
      className={styles.group}
      disabled={disabled}
      {...(named ? { "aria-labelledby": legendId } : {})}
    >
      {legend === undefined ? null : (
        <legend className={styles.legend}>
          {named ? <span id={legendId}>{legend}</span> : legend}
          {nameInfo(info, legend)}
        </legend>
      )}
      {children}
    </fieldset>
  );
}

const GROUP_LAYOUTS = {
  stack: styles.group,
  columns: styles.columns,
  choices: styles.choiceList,
  choiceGrid: styles.choiceGrid,
};

/**
 * Related fields under one legend. `columns` puts them side by side when there is room (an Arabic and an English
 * name); `choices` lays out a set of checkboxes or radios.
 */
export function FieldGroup({
  legend,
  help,
  info,
  layout = "stack",
  disabled,
  children,
}: Readonly<{
  legend?: ReactNode;
  help?: ReactNode;
  /** An `InfoTip` beside the legend (ADR-370); the group is named by the legend alone, not by the button. */
  info?: ReactNode;
  layout?: "stack" | "columns" | "choices" | "choiceGrid";
  /** Disables every control inside at once (a form while it saves). */
  disabled?: boolean;
  children: ReactNode;
}>) {
  const body =
    layout === "stack" ? children : <div className={GROUP_LAYOUTS[layout]}>{children}</div>;
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
    <GroupFieldset legend={legend} info={info} disabled={disabled}>
      {helpText}
      {body}
    </GroupFieldset>
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
  return (
    <form
      {...props}
      {...(card ? { "data-card": "" } : {})}
      className={join(styles.group, card && styles.formCard, className)}
    />
  );
}
