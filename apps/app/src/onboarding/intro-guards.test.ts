import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The intro asks for no permission and collects no data (FR-1800, STORE_COMPLIANCE): it must not even be able to. These
 * read the intro's own sources, so a later change that reaches for a permission, a tracker or the network fails here. The one
 * request it may make is the anonymous read of the public configuration that holds the cards' order (T-802b, ADR-611).
 */
const FOLDER = import.meta.dirname;
const ROUTE = join(import.meta.dirname, "..", "..", "app", "intro.tsx");

const sources = (): ReadonlyArray<{ file: string; text: string }> =>
  [
    ...readdirSync(FOLDER)
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => join(FOLDER, name)),
    ROUTE,
  ].map((file) => ({ file, text: readFileSync(file, "utf8") }));

const FORBIDDEN_IMPORTS = [
  "expo-notifications",
  "expo-location",
  "expo-camera",
  "expo-contacts",
  "expo-media-library",
  "expo-tracking-transparency",
  "expo-device",
  "react-native-nfc-manager",
  "#src/push/",
  "#src/nfc/",
  "#src/auth/",
  "#src/api/client.ts",
  "#src/api/session.ts",
];

describe("the intro's sources", () => {
  it("find the intro's files", () => {
    expect(sources().length).toBeGreaterThanOrEqual(7);
  });

  it("import no permission, tracking, push, sign-in or network module", () => {
    for (const { file, text } of sources()) {
      for (const module of FORBIDDEN_IMPORTS) {
        expect(text, `${file} imports ${module}`).not.toMatch(
          new RegExp(`from\\s+["']${module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
      }
    }
  });

  it("use the app session for its local store, and for one anonymous read of the public configuration", () => {
    for (const { file, text } of sources()) {
      const imported = [
        ...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']#src\/api\/app-session/g),
      ];
      const allowed = file.endsWith("IntroScreen.tsx")
        ? ["api", "keyValueStore"]
        : ["keyValueStore"];
      for (const match of imported) {
        const names = (match[1] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "");
        expect(
          names.filter((name) => !allowed.includes(name)),
          file,
        ).toEqual([]);
      }
      expect(text, `${file} signs a request`).not.toMatch(/\bapi\.session\b/);
      expect(text, `${file} calls fetch`).not.toMatch(/\bfetch\s*\(/);
    }
    // The only request is the plain client reading GET /v1/config for the cards' order (T-802b, ADR-611): no sign-in, no body.
    const uses = sources().flatMap(({ text }) => text.match(/\bapi\.\w+/g) ?? []);
    expect(uses).toEqual(["api.client"]);
  });
});
