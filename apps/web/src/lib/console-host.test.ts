import { describe, expect, it } from "vitest";
import { consoleHome, hostKind, routeFor } from "#src/lib/console-host.ts";

const ORIGINS = {
  dashboardOrigin: "https://questify.nafes.com",
  consoleOrigin: "https://console.questify.nafes.com",
};
const LOCAL = {
  dashboardOrigin: "http://localhost:3100",
  consoleOrigin: "http://console.localhost:3100",
};
const at = (pathname: string, search = "") => ({ pathname, search });

describe("hostKind", () => {
  it("is the console host only for the console origin's own host", () => {
    expect(hostKind("console.questify.nafes.com", ORIGINS)).toBe("console");
    expect(hostKind("CONSOLE.Questify.NAFES.com", ORIGINS)).toBe("console");
    expect(hostKind("questify.nafes.com", ORIGINS)).toBe("public");
  });

  it("compares the port too", () => {
    expect(hostKind("console.localhost:3100", LOCAL)).toBe("console");
    expect(hostKind("console.localhost:3200", LOCAL)).toBe("public");
    expect(hostKind("console.localhost", LOCAL)).toBe("public");
  });

  it("treats anything unknown or missing as public", () => {
    expect(hostKind(null, ORIGINS)).toBe("public");
    expect(hostKind("", ORIGINS)).toBe("public");
    expect(hostKind("console.questify.nafes.com.evil.example", ORIGINS)).toBe("public");
    expect(hostKind("evil.console.questify.nafes.com", ORIGINS)).toBe("public");
  });
});

describe("routeFor on the public host", () => {
  it.each(["/en/console", "/ar/console", "/en/console/", "/en/console/organizers/x"])(
    "sends %s to the console host with a permanent redirect",
    (pathname) => {
      expect(routeFor("public", at(pathname), ORIGINS)).toEqual({
        kind: "redirect",
        status: 308,
        location: `https://console.questify.nafes.com${pathname}`,
      });
    },
  );

  it("keeps the query", () => {
    expect(routeFor("public", at("/en/console/players", "?q=1&x=2"), ORIGINS)).toMatchObject({
      location: "https://console.questify.nafes.com/en/console/players?q=1&x=2",
    });
  });

  it.each([
    "/",
    "/en",
    "/en/consoleX",
    "/en/sign-in",
    "/en/organizers",
    "/en/account",
    "/console",
    "/fr/console",
  ])("serves %s itself", (pathname) => {
    expect(routeFor("public", at(pathname), ORIGINS)).toEqual({ kind: "serve" });
  });
});

describe("routeFor on the console host", () => {
  it.each([
    "/en/console",
    "/ar/console/tickets",
    "/en/sign-in",
    "/ar/sign-in",
    "/en/account",
    "/en/account/sessions",
  ])("serves %s", (pathname) => {
    expect(routeFor("console", at(pathname), ORIGINS)).toEqual({ kind: "serve" });
  });

  it("leaves the language of `/` to the proxy, which sends it to that language's console", () => {
    expect(routeFor("console", at("/"), ORIGINS)).toEqual({ kind: "console_home" });
    expect(consoleHome(ORIGINS, "ar")).toEqual({
      kind: "redirect",
      status: 307,
      location: "https://console.questify.nafes.com/ar/console",
    });
  });

  it.each(["/en", "/ar", "/en/"])("sends the home page %s to the console", (pathname) => {
    expect(routeFor("console", at(pathname, "?x=1"), ORIGINS)).toEqual({
      kind: "redirect",
      status: 307,
      location: `https://console.questify.nafes.com/${pathname.slice(1, 3)}/console`,
    });
  });

  it.each([
    "/en/organizers",
    "/en/organizers/o1/events/e1",
    "/ar/e/ABC123",
    "/en/consoleX",
    "/en/sign-up",
    "/en/forgot-password",
    "/en/reset-password",
    "/en/invite",
    "/en/sign-inX",
    "/en/accounts",
  ])("sends every other page, such as %s, to the public host", (pathname) => {
    expect(routeFor("console", at(pathname, "?a=b"), ORIGINS)).toEqual({
      kind: "redirect",
      status: 308,
      location: `https://questify.nafes.com${pathname}?a=b`,
    });
  });

  it("leaves a path without a language to the language step", () => {
    expect(routeFor("console", at("/organizers"), ORIGINS)).toEqual({ kind: "serve" });
  });
});

describe("no open redirect (plan review 86, item 3)", () => {
  it("keeps a path that looks like another host on the configured origin", () => {
    const sent = routeFor("console", at("/en//evil.example/x"), ORIGINS);
    expect(sent).toMatchObject({ location: "https://questify.nafes.com/en//evil.example/x" });
    const publicSent = routeFor("public", at("/en/console//evil.example"), ORIGINS);
    expect(publicSent).toMatchObject({
      location: "https://console.questify.nafes.com/en/console//evil.example",
    });
    for (const route of [sent, publicSent]) {
      if (route.kind === "redirect") {
        expect(new URL(route.location).host).not.toBe("evil.example");
      }
    }
  });

  it("never reads a forwarded host: a public Host with x-forwarded-host set to the console is public", () => {
    // The proxy passes only `Host`; a client-sent x-forwarded-host never reaches hostKind.
    expect(hostKind("questify.nafes.com", ORIGINS)).toBe("public");
    expect(routeFor("public", at("/en/console"), ORIGINS)).toMatchObject({
      location: "https://console.questify.nafes.com/en/console",
    });
  });
});
