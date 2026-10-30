import type { ButtonHTMLAttributes } from "react";
import { AppLink, type AppLinkProps } from "#src/ui/AppLink.tsx";
import styles from "#src/ui/form.module.css";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

type Look = Readonly<{
  variant?: ButtonVariant | undefined;
  size?: "md" | "sm" | undefined;
  /** Fills the row, its content spread to both ends: a disclosure that names what it opens. */
  wide?: boolean | undefined;
}>;

/** The class names of a button look. */
function buttonClass({ variant = "secondary", size = "md", wide = false }: Look = {}): string {
  return [
    styles.button,
    styles[variant],
    size === "sm" ? styles.small : "",
    wide ? styles.wide : "",
  ]
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
  wide,
  type = "button",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & Look) {
  return (
    <button
      type={type}
      {...props}
      className={[buttonClass({ variant, size, wide }), className].filter(Boolean).join(" ")}
    />
  );
}

/** A link that looks like a button: for an action that opens another page. */
export function ButtonLink({ variant, size, wide, className, ...props }: AppLinkProps & Look) {
  return (
    <AppLink
      {...props}
      className={[buttonClass({ variant, size, wide }), className].filter(Boolean).join(" ")}
    />
  );
}
