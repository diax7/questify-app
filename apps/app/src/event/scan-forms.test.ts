import { QUEST_CODE_HOSTS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { readScan } from "#src/event/scan.ts";

const ID = "5f0c2b1e-8d4a-4c3b-9e7f-0a1b2c3d4e5f";
const OWN = `https://${QUEST_CODE_HOSTS[0]}`;
const STAGING = "https://questify-web-staging-4ecphq.cranl.net";

/** A token laid out as `apps/api/src/quests/qr.ts` signs it: format, id, version, a 16-byte tag. */
function token(format: number): string {
  const bytes = Buffer.concat([
    Buffer.from([format]),
    Buffer.from(ID.replaceAll("-", ""), "hex"),
    Buffer.from([0, 0, 0, 1]),
    Buffer.alloc(16, 7),
  ]);
  return bytes.toString("base64url");
}

/** Which scan each format reads as under each path, on a host this build reads. */
const EXPECTED: Record<string, Record<number, string>> = {
  q: { 1: "quest", 4: "step", 5: "reveal", 7: "other" },
  s: { 1: "other", 4: "other", 5: "other", 7: "screen" },
};

describe("which printed forms a scan accepts", () => {
  for (const origin of [OWN, STAGING, "https://evil.example"]) {
    for (const path of ["q", "s"]) {
      for (const format of [0x01, 0x04, 0x05, 0x07]) {
        const expected = origin === "https://evil.example" ? "other" : EXPECTED[path]?.[format];
        it(`reads format ${format} under /${path}/ on ${origin} as ${expected}`, () => {
          expect(readScan(`${origin}/${path}/${token(format)}`, STAGING).kind).toBe(expected);
        });
      }
    }
  }
});
