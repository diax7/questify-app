import type { ReactNode } from "react";
import styles from "#src/ui/icon.module.css";

/**
 * The dashboard's icons (T-599c): one line-drawn set on a 24 by 24 grid, drawn in the text colour of the place they
 * sit in, so a theme or a hover state recolours them with no file to swap. They are decoration beside a word or inside
 * a control that carries its own name; the 3D artwork of the brand deck is for the player app (ADR-013).
 */
const SHAPES = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M17 14.2c2.6.3 4.5 2.2 4.5 5.8" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </>
  ),
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13" />
      <path d="M12 8H8a2.5 2.5 0 1 1 0-5c2.5 0 4 5 4 5Zm0 0h4a2.5 2.5 0 1 0 0-5c-2.5 0-4 5-4 5Z" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4h8v6a4 4 0 0 1-8 0V4Z" />
      <path d="M8 6H4v2a4 4 0 0 0 4 4M16 6h4v2a4 4 0 0 1-4 4M12 14v4M8.5 21h7M9 18h6" />
    </>
  ),
  heart: (
    <path d="M12 20.5S3 15 3 8.8A4.8 4.8 0 0 1 12 6.4a4.8 4.8 0 0 1 9 2.4C21 15 12 20.5 12 20.5Z" />
  ),
  bolt: <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z" />,
  star: <path d="m12 3 2.7 6 6.3.7-4.7 4.3 1.3 6.5-5.6-3.3-5.6 3.3 1.3-6.5L3 9.7 9.3 9 12 3Z" />,
  userPlus: (
    <>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3 20c0-3.6 3-6 7-6s7 2.4 7 6M19 8v6M16 11h6" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.5V6L12 3Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>
  ),
  screen: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2.5" />
      <path d="M12 16v4M8 20h8" />
    </>
  ),
  megaphone: (
    <path d="M3 10.5v3a1 1 0 0 0 1 1h3l8 4.5V5l-8 4.5H4a1 1 0 0 0-1 1ZM19 9.5a4 4 0 0 1 0 5" />
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.2-2.5 3.8M12 17.2h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M9.9 5.7A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-2.6 3.4M6.5 7.1A17 17 0 0 0 2 12s3.6 6.5 10 6.5a10 10 0 0 0 4-.8" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13h5l1.5 3h5l1.5-3h5" />
      <path d="M5.5 5h13L21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6L5.5 5Z" />
    </>
  ),
  alert: <path d="M12 3 2.5 20h19L12 3ZM12 10v4M12 17h.01" />,
  award: (
    <>
      <circle cx="12" cy="9" r="6" />
      <path d="M8.5 14.5 7 22l5-3 5 3-1.5-7.5" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  ticket: (
    <path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3ZM14 7v2M14 11v2M14 15v2" />
  ),
  file: (
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM14 3v4h4M9 12h6M9 16h6" />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.6-4-9s1.4-6.5 4-9Z" />
    </>
  ),
  map: (
    <>
      <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5Z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  sponsor: (
    <>
      <circle cx="12" cy="9" r="5.5" />
      <path d="m8.8 13.6-1.6 7.4 4.8-2.8 4.8 2.8-1.6-7.4" />
    </>
  ),
  signOut: <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 8l4 4-4 4M20 12H9" />,
} as const satisfies Record<string, ReactNode>;

export type IconName = keyof typeof SHAPES;

/**
 * One icon, 20px by default, in the surrounding text colour. `mirror` flips it in a right-to-left page, for a
 * picture with a direction (the arrow that leaves).
 */
export function Icon({ name, mirror = false }: Readonly<{ name: IconName; mirror?: boolean }>) {
  return (
    <svg
      className={mirror ? `${styles.icon} ${styles.mirror}` : styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
