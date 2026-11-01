import { describe, expect, it } from "vitest";
import {
  USAGE_API,
  readUsageEvents,
  readUsageOrganizers,
  usageEventsPath,
} from "#src/lib/console-usage.ts";

const ID = "22222222-2222-4222-8222-222222222222";
const organizer = {
  id: ID,
  name: "Najd Events",
  events: 2,
  players: 1240,
  invitationsSent: 800,
  alertEmails: 0,
};
const event = {
  id: "33333333-3333-4333-8333-333333333333",
  name: { ar: "يوم التقنية", en: "Tech Day" },
  status: "live",
  players: 1240,
  invitationsSent: 800,
  alertEmails: 3,
};

describe("readUsageOrganizers", () => {
  it("reads the rows as the API sends them", () => {
    expect(readUsageOrganizers({ organizers: [organizer] })).toEqual([organizer]);
    expect(readUsageOrganizers({ organizers: [] })).toEqual([]);
  });

  it.each([
    ["not an object", "rows"],
    ["no list", {}],
    ["a negative count", { organizers: [{ ...organizer, players: -1 }] }],
    ["a count with a fraction", { organizers: [{ ...organizer, events: 1.5 }] }],
    ["a missing figure", { organizers: [{ ...organizer, alertEmails: undefined }] }],
    ["an unknown field (a contact detail)", { organizers: [{ ...organizer, owner: "a@b.test" }] }],
    ["an id that is not a UUID", { organizers: [{ ...organizer, id: "nope" }] }],
    ["more than 100 rows", { organizers: Array.from({ length: 101 }, () => organizer) }],
  ])("shows the error state for %s", (_name, body) => {
    expect(readUsageOrganizers(body)).toBeUndefined();
  });
});

describe("readUsageEvents", () => {
  it("reads an organizer's events", () => {
    const body = { organizer: { id: ID, name: "Najd Events" }, events: [event] };
    expect(readUsageEvents(body)).toEqual(body);
  });

  it("keeps a name in one language only", () => {
    const body = {
      organizer: { id: ID, name: "Najd Events" },
      events: [{ ...event, name: { ar: null, en: "Tech Day" } }],
    };
    expect(readUsageEvents(body)).toEqual(body);
  });

  it.each([
    ["a status the page has no word for", { ...event, status: "paused" }],
    ["an unknown field", { ...event, players_list: [] }],
    ["a missing name", { ...event, name: undefined }],
  ])("shows the error state for %s", (_name, bad) => {
    expect(
      readUsageEvents({ organizer: { id: ID, name: "Najd Events" }, events: [bad] }),
    ).toBeUndefined();
  });
});

describe("usageEventsPath", () => {
  it("is the list path with the organizer", () => {
    expect(usageEventsPath(ID)).toBe(`${USAGE_API}/organizers/${ID}`);
  });
});
