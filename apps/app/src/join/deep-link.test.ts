import { describe, expect, it } from "vitest";
import { routeForIncoming } from "#src/join/deep-link.ts";

const TOKEN = "a".repeat(50);
const SHORT_TOKEN = "a".repeat(49);

describe("routeForIncoming", () => {
  it.each([
    // An operator invite: the path alone, or the app link, with exactly 50 token characters.
    [`operator-invite/${TOKEN}`, `/operator-invite/${TOKEN}`],
    [`/operator-invite/${TOKEN}`, `/operator-invite/${TOKEN}`],
    [`questify://operator-invite/${TOKEN}`, `/operator-invite/${TOKEN}`],
    [`https://questify.sa/en/op#${TOKEN}`, `/operator-invite/${TOKEN}`],
    [`/operator-invite/${SHORT_TOKEN}`, "/"],
    [`/operator-invite/${TOKEN}a`, "/"],
    [`/operator-invite/${TOKEN}/`, "/"],
    // The dashboard address without a language segment is not an invite and not a join link.
    [`https://app.questify.sa/op#${TOKEN}`, "/"],
    [`https://app.questify.sa/op#invite=${TOKEN}`, "/"],
    // A join link as a full https URL: the code is upper-cased, a query or fragment is dropped.
    ["https://questify.nafes.com/en/e/ABCD", "/join/ABCD?via=link"],
    ["https://questify.nafes.com/ar/e/ABCD2345?x=1", "/join/ABCD2345?via=link"],
    // Links printed before ADR-838 name questify.sa and still open the join card.
    ["https://questify.sa/en/e/ABCD", "/join/ABCD?via=link"],
    ["https://www.questify.sa/en/e/ABCD", "/join/ABCD?via=link"],
    ["https://questify.sa/ar/e/ABCD2345?x=1", "/join/ABCD2345?via=link"],
    ["https://questify.sa/ar/e/ABCD2345#frag", "/join/ABCD2345?via=link"],
    ["https://questify.sa/en/e/abc234", "/join/ABC234?via=link"],
    // A join link as its path alone.
    ["/en/e/abcd", "/join/ABCD?via=link"],
    ["/ar/e/AbCd12/", "/join/ABCD12?via=link"],
    ["/ar/e/AbCd12?via=x", "/join/ABCD12?via=link"],
    ["/ar/e/AbCd12#x", "/join/ABCD12?via=link"],
    // Codes are 4 to 12 letters or digits.
    ["/ar/e/ABC", "/"],
    ["/ar/e/ABCDEFGHIJKL", "/join/ABCDEFGHIJKL?via=link"],
    ["/ar/e/ABCDEFGHIJKLM", "/"],
    // Not a join link: a wrong language, a short code, plain http, a bare code, another path or site.
    ["https://questify.sa/fr/e/ABCD", "/"],
    ["https://questify.sa/en/e/AB", "/"],
    ["http://questify.sa/en/e/ABCD", "/"],
    ["https://questify.nafes.com.evil.test/en/e/ABCD", "/"],
    ["/fr/e/ABCD", "/"],
    ["ABCD", "/"],
    ["/join/ABCD", "/"],
    ["https://example.com/other", "/"],
    ["https://example.com/en/e/ABCD", "/"],
    ["", "/"],
    ["/", "/"],
  ])("opens %j at %j", (incoming, route) => {
    expect(routeForIncoming(incoming)).toBe(route);
  });
});
