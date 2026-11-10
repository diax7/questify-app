import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/**
 * Only `issuedBody` puts a player's tokens in an answer, and the web forwarder rebuilds that answer (verify, signup
 * and refresh are its steps 1 and 2), so no token reaches a browser page (T-803 P2). A token property anywhere else
 * in the API's code could carry one into a body the forwarder passes on unchanged: this test refuses it until the
 * forwarder handles that path too.
 */
const ALLOWED = new Set(["players/routes.ts", "players/sign-in.ts"]);

/** `accessToken:` or `refreshToken:` as a key or a type member, quoted, a shorthand `{ accessToken }`, or `.accessToken`. */
const TOKEN_PROPERTY =
  /(?<![\w$])(?:accessToken|refreshToken)\s*\??\s*:|["'`](?:accessToken|refreshToken)["'`]|[{,]\s*(?:accessToken|refreshToken)\s*[,}]|\.(?:accessToken|refreshToken)(?![\w$])/u;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });

describe("player token properties in the API's code", () => {
  it("appear only in the two sign-in files", () => {
    const found = sources(SRC)
      .filter((path) => TOKEN_PROPERTY.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path).replaceAll("\\", "/"))
      .toSorted();
    expect(found.filter((path) => !ALLOWED.has(path))).toEqual([]);
    expect(found).toEqual([...ALLOWED].toSorted());
  });

  it("are caught in every form a body could carry them", () => {
    for (const text of [
      "return { accessToken: a };",
      "type T = { refreshToken?: string };",
      'body["accessToken"]',
      "send({ accessToken, other })",
      "reply.send(issued.refreshToken)",
    ]) {
      expect(TOKEN_PROPERTY.test(text), text).toBe(true);
    }
    for (const text of [
      "const accessToken = await fetchIt();",
      "accessTokenSeconds: 3600",
      'body["access_token"]',
    ]) {
      expect(TOKEN_PROPERTY.test(text), text).toBe(false);
    }
  });
});
