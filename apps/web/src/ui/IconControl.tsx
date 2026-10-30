import type { ButtonHTMLAttributes } from "react";
import { AppLink, type AppLinkProps } from "#src/ui/AppLink.tsx";
import { Icon, type IconName } from "#src/ui/Icon.tsx";
import styles from "#src/ui/icon.module.css";

type IconProps = Readonly<{
  icon: IconName;
  /** The control's accessible name and its tooltip: say what it does, in the page's language. */
  label: string;
  /** Turns the icon around in a right-to-left page (a picture with a direction). */
  mirror?: boolean;
}>;

/** A button that shows only an icon. Its `label` is both its accessible name and the tooltip on hover and focus. */
export function IconButton({
  icon,
  label,
  mirror,
  type = "button",
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & IconProps) {
  return (
    <button
      type={type}
      aria-label={label}
      data-tooltip={label}
      {...props}
      className={[styles.control, className].filter(Boolean).join(" ")}
    >
      <Icon name={icon} mirror={mirror === true} />
    </button>
  );
}

/** A link that shows only an icon, named and explained like an `IconButton`. */
export function IconLink({
  icon,
  label,
  mirror,
  className,
  ...props
}: Omit<AppLinkProps, "children"> & IconProps) {
  return (
    <AppLink
      aria-label={label}
      data-tooltip={label}
      {...props}
      className={[styles.control, className].filter(Boolean).join(" ")}
    >
      <Icon name={icon} mirror={mirror === true} />
    </AppLink>
  );
}
