import type { Page, Request } from "@playwright/test";

/** How long the page's requests must stay quiet before it counts as settled, and the longest wait for that. */
export const QUIET_MS = 300;
export const SETTLE_LIMIT_MS = 5000;

/** The part of a Playwright page the request count listens to. */
export type WatchedPage = Pick<Page, "on" | "mainFrame" | "url" | "waitForTimeout">;

const settlers = new WeakMap<WatchedPage, () => Promise<void>>();

/** True for the request that loads a new document into the page's top frame (not a fetch, not an iframe). */
function opensNewDocument(page: WatchedPage, request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    // A service worker's request has no frame: it never replaces the page's document.
    return false;
  }
}

/**
 * Counts the page's requests from now on, for `waitUntilSettled`: a page that fetches its data after it first draws is
 * read once it has it. Faster than Playwright's `networkidle`, which always waits a fixed 500ms (it was a fifth of the
 * layout check's time). Call it once, before the first page is opened.
 *
 * A new document drops the requests the old one still had open: the browser cancels them, and Playwright does not
 * always report that (CI runs 42412664875 and 42422503343: the event page's rehearsal read, cut off by `page.goto` to
 * the next page, stayed open in the count forever, and the events page after it "never settled").
 *
 * The same holds for a read the old document starts after the next document's request began: the pairing pages poll
 * `GET /v1/device` every 300 ms to 3 s, so one poll often fires in that gap, is cut off by the commit and is never
 * reported (the phone a11y sweep on /kiosk, 2026-11-14). So the commit of a new top-frame document (`framenavigated`
 * after a navigation request, not a pushState) drops every read still open as well.
 */
export function watchRequests(page: WatchedPage): void {
  const requests = { open: new Set<Request>(), lastActivity: Date.now(), loading: false };
  const change = (request: Request, started: boolean): void => {
    if (started && opensNewDocument(page, request)) {
      requests.open.clear();
      requests.loading = true;
    }
    requests.open[started ? "add" : "delete"](request);
    requests.lastActivity = Date.now();
  };
  page.on("request", (request) => change(request, true));
  page.on("requestfinished", (request) => change(request, false));
  page.on("requestfailed", (request) => change(request, false));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && requests.loading) {
      requests.loading = false;
      requests.open.clear();
      requests.lastActivity = Date.now();
    }
  });
  settlers.set(page, async () => {
    const giveUp = Date.now() + SETTLE_LIMIT_MS;
    while (requests.open.size > 0 || Date.now() - requests.lastActivity < QUIET_MS) {
      if (Date.now() >= giveUp) {
        const waiting = [...requests.open].map((one) => `${one.method()} ${one.url()}`).join(", ");
        throw new Error(
          `${page.url()}: ${requests.open.size} requests still open after ${SETTLE_LIMIT_MS}ms (${waiting}), so the page never settled`,
        );
      }
      await page.waitForTimeout(25);
    }
  });
}

/** Waits until no request of the page is open and none has started or ended for 300ms; fails after five seconds. */
export async function settleRequests(page: WatchedPage): Promise<void> {
  const settle = settlers.get(page);
  if (settle === undefined) {
    throw new Error("watchRequests(page) must be called before the first page is opened");
  }
  await settle();
}
