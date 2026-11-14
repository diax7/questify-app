import { EventEmitter } from "node:events";
import type { Request } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { QUIET_MS, settleRequests, watchRequests, type WatchedPage } from "#e2e/open-requests.ts";

const TOP = { name: "top frame" };
const IFRAME = { name: "an iframe" };

/** A stand-in for a Playwright request: a document load when `navigation` is true, else a fetch. */
const request = (url: string, navigation: boolean, frame: object = TOP) =>
  ({
    url: () => url,
    method: () => "GET",
    isNavigationRequest: () => navigation,
    frame: () => frame,
  }) as unknown as Request;

/** A stand-in for a Playwright page: its request events are emitted by the test. */
function fakePage() {
  const events = new EventEmitter();
  const page = {
    on: (name: string, listener: (request: Request) => void) => events.on(name, listener),
    mainFrame: () => TOP,
    url: () => "http://localhost:3100/en/organizers/o/events",
    waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } as unknown as WatchedPage;
  watchRequests(page);
  return { page, emit: (name: string, one: unknown) => events.emit(name, one) };
}

/** How long settling takes, in ms; rejects as settling does. */
async function timeToSettle(page: WatchedPage): Promise<number> {
  const started = Date.now();
  await settleRequests(page);
  return Date.now() - started;
}

describe("the request count waitUntilSettled reads", () => {
  it("forgets a read the next document cut off without an answer (CI 42412664875, 42422503343)", async () => {
    const { page, emit } = fakePage();
    const eventPage = request("/en/organizers/o/events/e", true);
    emit("request", eventPage);
    emit("requestfinished", eventPage);
    // The event page's first rehearsal read is still on the way when the test opens the next page.
    emit("request", request("/v1/organizers/o/events/e/rehearsal", false));
    const next = request("/en/organizers/o/events", true);
    emit("request", next);
    emit("requestfinished", next);
    expect(await timeToSettle(page)).toBeLessThan(2000);
  });

  it("still waits for a read of the open document", async () => {
    const { page, emit } = fakePage();
    const read = request("/v1/organizers/o/events", false);
    emit("request", read);
    setTimeout(() => emit("requestfinished", read), 600);
    expect(await timeToSettle(page)).toBeGreaterThanOrEqual(600 + QUIET_MS - 50);
  });

  it("keeps the page's reads when only an iframe loads a new document", async () => {
    const { page, emit } = fakePage();
    const read = request("/v1/organizers/o/events", false);
    emit("request", read);
    const embed = request("/embed", true, IFRAME);
    emit("request", embed);
    emit("requestfinished", embed);
    setTimeout(() => emit("requestfinished", read), 600);
    expect(await timeToSettle(page)).toBeGreaterThanOrEqual(600 + QUIET_MS - 50);
  });

  it("forgets a poll the old document sent after the next document's request began (the kiosk page's GET /v1/device)", async () => {
    const { page, emit } = fakePage();
    const next = request("/en/kiosk", true);
    emit("request", next);
    // The old document's timer fires before the commit: the browser cancels the read and nothing reports it.
    emit("request", request("/v1/device", false));
    emit("requestfinished", next);
    emit("framenavigated", TOP);
    expect(await timeToSettle(page)).toBeLessThan(2000);
  });

  it("keeps the reads open across a pushState, which is no new document", async () => {
    const { page, emit } = fakePage();
    const read = request("/v1/organizers/o/events", false);
    emit("request", read);
    emit("framenavigated", TOP);
    setTimeout(() => emit("requestfinished", read), 600);
    expect(await timeToSettle(page)).toBeGreaterThanOrEqual(600 + QUIET_MS - 50);
  });
});
