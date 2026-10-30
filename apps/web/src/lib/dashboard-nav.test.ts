import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_PAGES, eventPlaceIn } from "#src/lib/dashboard-nav.ts";

describe("eventPlaceIn", () => {
  it("finds the event and its page", () => {
    expect(eventPlaceIn("/organizers/o1/events/e1")).toEqual({ eventId: "e1", slug: "" });
    expect(eventPlaceIn("/organizers/o1/events/e1/quests")).toEqual({
      eventId: "e1",
      slug: "quests",
    });
  });

  it("is null outside an event", () => {
    expect(eventPlaceIn("/organizers/o1/events")).toBeNull();
    expect(eventPlaceIn("/organizers/o1/events/new")).toBeNull();
    expect(eventPlaceIn("/organizers/o1/team")).toBeNull();
    expect(eventPlaceIn("")).toBeNull();
  });
});

/** Pages a menu link does not open: the quest builder links to the codes page. */
const REACHED_FROM_ANOTHER_PAGE = new Set(["codes"]);

describe("EVENT_PAGES", () => {
  it("names each event page once, and every page folder is listed or reached from another page", () => {
    const slugs = EVENT_PAGES.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const pages = join(
      import.meta.dirname,
      "..",
      "app",
      "[lang]",
      "organizers",
      "[organizerId]",
      "events",
      "[eventId]",
    );
    const folders = new Set(
      readdirSync(pages, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    for (const slug of slugs.filter((each) => each !== "")) {
      expect(folders.has(slug), slug).toBe(true);
    }
    for (const folder of folders) {
      expect(slugs.includes(folder) || REACHED_FROM_ANOTHER_PAGE.has(folder), folder).toBe(true);
    }
  });
});
