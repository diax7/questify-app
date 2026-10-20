import type { CSSProperties } from "react";
import type { Theme } from "@questify/shared";

const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * A theme as CSS variables (`--color-text`, `--space-md`, `--radius-md`), set once on `<html>`. Style sheets use only
 * these names, so another theme restyles every page without touching them (NFR-024).
 */
export function themeVariables(theme: Theme): CSSProperties {
  const entries: [string, string][] = [
    ...Object.entries(theme.colors).map(([name, value]): [string, string] => [
      `--color-${kebab(name)}`,
      value,
    ]),
    ...Object.entries(theme.spacing).map(([name, value]): [string, string] => [
      `--space-${name}`,
      `${value}px`,
    ]),
    ...Object.entries(theme.radius).map(([name, value]): [string, string] => [
      `--radius-${name}`,
      `${value}px`,
    ]),
  ];
  return Object.fromEntries(entries) as CSSProperties;
}
