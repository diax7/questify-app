import type { CSSProperties } from "react";
import { colors, radius, spacing } from "@questify/shared";

const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The shared tokens as CSS variables (`--color-text`, `--space-md`, `--radius-md`), set once on `<html>`. */
export function tokenVariables(): CSSProperties {
  const entries: [string, string][] = [
    ...Object.entries(colors).map(([name, value]): [string, string] => [
      `--color-${kebab(name)}`,
      value,
    ]),
    ...Object.entries(spacing).map(([name, value]): [string, string] => [
      `--space-${name}`,
      `${value}px`,
    ]),
    ...Object.entries(radius).map(([name, value]): [string, string] => [
      `--radius-${name}`,
      `${value}px`,
    ]),
  ];
  return Object.fromEntries(entries) as CSSProperties;
}
