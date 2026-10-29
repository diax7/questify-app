import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import styles from "#src/ui/form.module.css";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

type Look = Readonly<{ variant?: ButtonVariant | undefined; size?: "md" | "sm" | undefined }>;

/** The class names of a button look, for the rare control that must stay a plain element (a file picker label). */
export function buttonClass({ variant = "secondary", size = "md" }: Look = {}): string {
  return [styles.button, styles[variant], size === "sm" ? styles.small : ""]
    .filter((name) => name !== "")
    .join(" ");
}

/**
 * A button. `primary` is the one main action of a form or dialog, `secondary` the others, `quiet` a light action in a
 * list, `danger` what deletes or ends something. A plain `type="button"` unless told otherwise.
 */
export function Button({
  variant,
  size,
  type = "button",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & Look) {
  return (
    <button
      type={type}
      {...props}
      className={[buttonClass({ variant, size }), className].filter(Boolean).join(" ")}
    />
  );
}

/** A link that looks like a button: for an action that opens another page. */
export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & Look) {
  return (
    <a
      {...props}
      className={[buttonClass({ variant, size }), className].filter(Boolean).join(" ")}
    />
  );
}
